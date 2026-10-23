# Extracted verbatim test function and decorators from the upstream MIT-licensed
# Triton reproduction. See tmem_upstream_manifest.json for source/hash/line range.
import torch
import pytest
from triton._internal_testing import is_blackwell
from triton.experimental import gluon
from triton.experimental.gluon import language as ttgl
from triton.experimental.gluon.language.nvidia.blackwell import TensorMemoryLayout, allocate_tensor_memory

@pytest.mark.skipif(not is_blackwell(), reason="Requires Blackwell")
@pytest.mark.parametrize("choice", [0, 1])
@pytest.mark.parametrize("mode,columns,early,outer_choice", [
    ("select", 64, False, 1),
    ("select", 32, False, 1),
    ("select", 0, False, 1),
    ("select", 64, True, 1),
    ("first", 64, False, 1),
    ("second", 64, False, 1),
    ("chain", 64, False, 0),
    ("chain", 64, False, 1),
])
def test_tmem_selected_descriptor_lifetime(choice, mode, columns, early, outer_choice):

    @gluon.jit
    def kernel(selector, out, temp_out, MODE: ttgl.constexpr, TEMP_COLS: ttgl.constexpr, EARLY_TEMP: ttgl.constexpr):
        layout: ttgl.constexpr = TensorMemoryLayout([128, 32], 1)
        first = allocate_tensor_memory(ttgl.float32, [128, 32], layout)
        second = allocate_tensor_memory(ttgl.float32, [128, 32], layout)
        first.store(ttgl.full([128, 32], 3, ttgl.float32, first.get_reg_layout()))
        second.store(ttgl.full([128, 32], 5, ttgl.float32, second.get_reg_layout()))
        if TEMP_COLS > 0 and EARLY_TEMP:
            temp = allocate_tensor_memory(ttgl.float32, [128, TEMP_COLS], layout)

        # This load is a uniform scalar. The condition is not a compile-time argument.
        choice = ttgl.load(selector)
        if MODE == "select" or MODE == "chain":
            if choice != 0:
                selected = first
            else:
                selected = second
        elif MODE == "first":
            selected = first
        else:
            selected = second

        if MODE == "chain":
            if choice != 0:
                alternate = second
            else:
                alternate = first
            if ttgl.load(selector + 1) == 0:
                selected = alternate

        if TEMP_COLS > 0:
            if not EARLY_TEMP:
                temp = allocate_tensor_memory(ttgl.float32, [128, TEMP_COLS], layout)
            temp.store(ttgl.full([128, TEMP_COLS], 7, ttgl.float32, temp.get_reg_layout()))

        values = selected.load()
        reg: ttgl.constexpr = values.type.layout
        r = ttgl.arange(0, 128, ttgl.SliceLayout(1, reg))[:, None]
        c = ttgl.arange(0, 32, ttgl.SliceLayout(0, reg))[None, :]
        ttgl.store(out + r * 32 + c, values)
        if TEMP_COLS > 0:
            temporary = temp.load()
            treg: ttgl.constexpr = temporary.type.layout
            tr = ttgl.arange(0, 128, ttgl.SliceLayout(1, treg))[:, None]
            tc = ttgl.arange(0, TEMP_COLS, ttgl.SliceLayout(0, treg))[None, :]
            ttgl.store(temp_out + tr * TEMP_COLS + tc, temporary)

    selector = torch.tensor([choice, outer_choice], device="cuda", dtype=torch.int32)
    out = torch.empty((128, 32), device="cuda", dtype=torch.float32)
    temporary = torch.empty((128, max(1, columns)), device="cuda", dtype=torch.float32)
    kernel[(1, )](selector, out, temporary, mode, columns, early, num_warps=4)
    expected = 3 if mode == "first" or (mode == "select" and choice) else 5
    if mode == "chain":
        expected = 3 if choice == outer_choice else 5
    torch.testing.assert_close(out, torch.full_like(out, expected), atol=0, rtol=0)
    if columns:
        torch.testing.assert_close(temporary, torch.full_like(temporary, 7), atol=0, rtol=0)
