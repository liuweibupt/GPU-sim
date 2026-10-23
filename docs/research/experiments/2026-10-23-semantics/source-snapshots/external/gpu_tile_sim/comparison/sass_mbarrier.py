"""Functional CUDA mbarrier state for compact dynamic-SASS execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction


class BarrierActionKind(StrEnum):
    INIT = "init"
    ARRIVE = "arrive"
    ARRIVE_EXPECT_TX = "arrive_expect_tx"


@dataclass(frozen=True, slots=True)
class BarrierAction:
    kind: BarrierActionKind
    address: int
    arrivals: int = 0
    transaction_bytes: int = 0


@dataclass(frozen=True, slots=True)
class BarrierWait:
    address: int
    phase: int


@dataclass(frozen=True, slots=True)
class _CompletionEvent:
    cycle: int
    arrivals: int
    transaction_bytes: int


@dataclass(slots=True)
class _BarrierState:
    generation: int = 0
    expected_arrivals: int = 0
    pending_arrivals: int = 0
    pending_transaction_bytes: int = 0
    events: list[_CompletionEvent] = field(default_factory=list)


class MBarrierTracker:
    """Track phase transitions from arrivals and asynchronous byte completion."""

    def __init__(self) -> None:
        self._states: dict[int, _BarrierState] = {}

    def apply(self, action: BarrierAction, cycle: int) -> None:
        state = self._states.setdefault(action.address, _BarrierState())
        self._advance_state(state, cycle)
        if action.kind is BarrierActionKind.INIT:
            self._initialize(state, action.arrivals)
            return
        if state.expected_arrivals <= 0:
            raise RuntimeError(f"mbarrier 0x{action.address:x} used before initialization")
        state.pending_arrivals -= action.arrivals
        state.pending_transaction_bytes += action.transaction_bytes
        if state.pending_arrivals < 0 or state.pending_transaction_bytes < 0:
            raise RuntimeError(
                f"mbarrier 0x{action.address:x} action {action} exceeds pending state "
                f"(generation={state.generation}, arrivals={state.pending_arrivals}, "
                f"transactions={state.pending_transaction_bytes}, events={state.events})"
            )
        self._transition_if_complete(state)

    def action_ready_cycle(self, action: BarrierAction, cycle: int) -> int | None:
        if action.kind is BarrierActionKind.INIT:
            return cycle
        state = self._states.get(action.address)
        if state is None:
            raise RuntimeError(f"mbarrier 0x{action.address:x} used before initialization")
        self._advance_state(state, cycle)
        if action.arrivals <= state.pending_arrivals:
            return cycle
        return self._projected_transition_cycle(action.address, state, state.generation + 1)

    def schedule_completion(
        self,
        address: int,
        *,
        cycle: int,
        arrivals: int = 0,
        transaction_bytes: int = 0,
    ) -> None:
        state = self._states.get(address)
        if state is None:
            raise RuntimeError(f"async completion targets unknown mbarrier 0x{address:x}")
        state.events.append(_CompletionEvent(cycle, arrivals, transaction_bytes))
        state.events.sort(key=lambda event: event.cycle)

    def has_state(self, address: int) -> bool:
        return address in self._states

    def wait_generation_cycle(self, wait: BarrierWait, generation: int, cycle: int) -> int | None:
        state = self._states.get(wait.address)
        if state is None:
            raise RuntimeError(f"TRYWAIT targets unknown mbarrier 0x{wait.address:x}")
        self._advance_state(state, cycle)
        if state.generation >= generation:
            return cycle
        return self._projected_transition_cycle(wait.address, state, generation)

    def latest_event_cycle(self) -> int:
        return max(
            (event.cycle for state in self._states.values() for event in state.events),
            default=0,
        )

    def debug_snapshot(
        self,
    ) -> dict[int, tuple[int, int, int, tuple[tuple[int, int, int], ...]]]:
        return {
            address: (
                state.generation,
                state.pending_arrivals,
                state.pending_transaction_bytes,
                tuple(
                    (event.cycle, event.arrivals, event.transaction_bytes)
                    for event in state.events
                ),
            )
            for address, state in self._states.items()
        }

    @staticmethod
    def _initialize(state: _BarrierState, count: int) -> None:
        if count <= 0:
            raise ValueError("mbarrier arrival count must be positive")
        state.generation = 0
        state.expected_arrivals = count
        state.pending_arrivals = count
        state.pending_transaction_bytes = 0
        state.events.clear()

    def _advance_state(self, state: _BarrierState, cycle: int) -> None:
        completed = [event for event in state.events if event.cycle <= cycle]
        if not completed:
            return
        state.events[:] = [event for event in state.events if event.cycle > cycle]
        for event in completed:
            state.pending_arrivals -= event.arrivals
            state.pending_transaction_bytes -= event.transaction_bytes
            self._validate_pending(None, state)
            self._transition_if_complete(state)

    @staticmethod
    def _transition_if_complete(state: _BarrierState) -> None:
        if state.pending_arrivals or state.pending_transaction_bytes:
            return
        state.generation += 1
        state.pending_arrivals = state.expected_arrivals

    def _projected_transition_cycle(
        self, address: int, state: _BarrierState, target_generation: int
    ) -> int | None:
        arrivals = state.pending_arrivals
        transactions = state.pending_transaction_bytes
        generation = state.generation
        for event in state.events:
            arrivals -= event.arrivals
            transactions -= event.transaction_bytes
            if arrivals < 0 or transactions < 0:
                raise RuntimeError(f"mbarrier 0x{address:x} completion exceeds pending work")
            if arrivals == 0 and transactions == 0:
                generation += 1
                if generation >= target_generation:
                    return event.cycle
                arrivals = state.expected_arrivals
        return None

    @staticmethod
    def _validate_pending(address: int | None, state: _BarrierState) -> None:
        if state.pending_arrivals >= 0 and state.pending_transaction_bytes >= 0:
            return
        label = "mbarrier" if address is None else f"mbarrier 0x{address:x}"
        raise RuntimeError(f"{label} completion exceeds pending work")


def barrier_action(instruction: SassInstruction) -> BarrierAction | None:
    opcode = instruction.opcode
    address = _shared_address(instruction)
    if address is None:
        return None
    if opcode == "SYNCS.EXCH.64":
        return BarrierAction(BarrierActionKind.INIT, address, _init_count(instruction))
    if opcode in ("SYNCS.ARRIVE.TRANS64", "SYNCS.ARRIVE.TRANS64.RED"):
        return BarrierAction(
            BarrierActionKind.ARRIVE_EXPECT_TX,
            address,
            # PTX defines arrive.expect_tx as one arrival even when the
            # lowered SASS executes with a warp-wide active mask.
            arrivals=1,
            transaction_bytes=_source_scalar(instruction, 1),
        )
    if opcode.startswith("SYNCS.ARRIVE"):
        return BarrierAction(
            BarrierActionKind.ARRIVE,
            address,
            arrivals=_arrival_count(instruction),
        )
    return None


def barrier_wait(instruction: SassInstruction) -> BarrierWait | None:
    if not instruction.opcode.startswith("SYNCS.PHASECHK.TRANS64.SIM_WAIT"):
        return None
    address = _shared_address(instruction)
    if address is None:
        raise ValueError("active mbarrier TRYWAIT has no shared-memory address")
    # SASS stores the parity bit in bit 31, unlike PTX's scalar parity value.
    return BarrierWait(address, (_source_scalar(instruction, 1) >> 31) & 1)


def unique_memory_addresses(instruction: SassInstruction) -> tuple[int, ...]:
    return tuple(dict.fromkeys(instruction.memory_addresses))


def _arrival_count(instruction: SassInstruction) -> int:
    opcode = instruction.opcode
    if "ART0" in opcode:
        return _source_scalar(instruction, 1)
    if "A1T0" in opcode:
        return instruction.active_lanes
    if "A0T" in opcode:
        return 0
    raise ValueError(f"unsupported mbarrier arrival encoding: {opcode}")


def _init_count(instruction: SassInstruction) -> int:
    encoded = _source_scalar(instruction, 1)
    lower = (encoded & 0xFFFFFFFF) >> 1
    return (-(lower - 0x100000)) & 0xFFFFFFFF


def _source_scalar(instruction: SassInstruction, index: int) -> int:
    if len(instruction.source_values) <= index or not instruction.source_values[index]:
        raise ValueError(f"{instruction.opcode} requires traced source register values")
    return int(instruction.source_values[index][0])


def _shared_address(instruction: SassInstruction) -> int | None:
    return instruction.memory_addresses[0] if instruction.memory_addresses else None
