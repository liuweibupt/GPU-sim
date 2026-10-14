import test from "node:test";
import assert from "node:assert/strict";
import {indexTraffic, trafficAt, pointAlongRoute, flowColor, FLOW_COLORS} from "../web/traffic-overlay.js";

const topology = {nodes: [{id: "sm-0", kind: "sm"}, {id: "r", kind: "router"}, {id: "l2", kind: "l2"}], links: [
  {id: "first", sourceId: "sm-0", targetId: "r", bytesPerCycle: 64, latencyCycles: 8},
  {id: "second", sourceId: "r", targetId: "l2", bytesPerCycle: 64, latencyCycles: 8},
]};
function event(id, start, end, stage, linkId = "first") {
  return {id, start, end, componentId: linkId, args: {stage, linkId,
    flow: {packetId: "packet", requestId: "request", bytes: 128, kind: "read-response", shared: true,
      originId: "sm-0", destinationId: "l2", sourceId: "sm-0", targetId: "l2"}}};
}

test("traffic uses declared hops and explicit queues; ordinary task spans never become packets", () => {
  const events = [event("hop0", 10, 20, "transfer"), event("queue", 20, 23, "queue", "second"),
    event("hop1", 23, 30, "transfer", "second"), event("bad", 1, 9, "transfer", "missing"),
    {id: "compute", start: 0, end: 50, componentId: "sm-0", args: {stage: "compute"}},
    {...event("service", 30, 40, "service"), componentId: "l2"}];
  const before = JSON.stringify(events), index = indexTraffic(topology, events);
  assert.equal(index.transfers.length, 2); assert.equal(index.queues.length, 1); assert.equal(index.services.length, 1);
  assert.equal(index.omittedTransfers, 1);
  assert.equal(index.byRequest.get("request").length, 2);
  assert.deepEqual([index.transfers[0].link.sourceId, index.transfers[0].link.targetId], ["sm-0", "r"]);
  assert.equal(JSON.stringify(events), before);
});

test("packets and queues respect source interval boundaries, pause, deterministic seek and rewind", () => {
  const events = [event("hop0", 10, 20, "transfer"), event("queue", 20, 23, "queue", "second"),
    event("hop1", 23, 30, "transfer", "second"), event("instant", 15, 15, "transfer")];
  const index = indexTraffic(topology, events);
  assert.equal(trafficAt(index, 9).transfers.length, 0);
  assert.equal(trafficAt(index, 10).transfers[0].progress, 0);
  assert.equal(trafficAt(index, 15).transfers[0].progress, .5);
  assert.equal(trafficAt(index, 20).transfers.length, 0);
  assert.equal(trafficAt(index, 20).queues.length, 1);
  assert.equal(trafficAt(index, 23).queues.length, 0);
  assert.equal(trafficAt(index, 23).transfers[0].event.id, "hop1");
  assert.equal(trafficAt(index, 30).transfers.length, 0);
  assert.deepEqual(trafficAt(index, 15), trafficAt(index, 15));
  assert.deepEqual(trafficAt(index, NaN), {transfers: [], queues: [], services: []});
  assert.equal(trafficAt(index, 10).transfers[0].progress, 0);
});

test("multi-segment motion is distance-proportional with exact endpoints and semantic colors", () => {
  const route = [{x: 0, y: 0}, {x: 30, y: 0}, {x: 30, y: 70}];
  assert.deepEqual(pointAlongRoute(route, 0), {x: 0, y: 0, angle: 0});
  assert.deepEqual(pointAlongRoute(route, .5), {x: 30, y: 20, angle: 90});
  assert.deepEqual(pointAlongRoute(route, 1), {x: 30, y: 70, angle: 90});
  assert.equal(pointAlongRoute([], .5), null);
  assert.equal(flowColor({kind: "read-response", shared: true}), FLOW_COLORS.shared);
  assert.equal(flowColor({kind: "read-response", shared: false}), FLOW_COLORS["read-response"]);
  assert.equal(flowColor({kind: "read-request", shared: true}), FLOW_COLORS["read-request"]);
  assert.equal(flowColor({kind: "writeback", shared: true}), FLOW_COLORS.writeback);
});

test("native memory queue and service records need no fabricated packet payload", () => {
  const events = [
    {id: "lookup-wait", start: 5, end: 10, componentId: "l2", args: {stage: "queue", requestId: "r1", dataKey: "shared-input", operation: "lookup"}},
    {id: "lookup", start: 10, end: 22, componentId: "l2", args: {stage: "service", requestId: "r1", dataKey: "shared-input", operation: "lookup"}},
  ];
  const index = indexTraffic(topology, events);
  assert.equal(index.transfers.length, 0);
  assert.equal(trafficAt(index, 5).queues[0].nodeId, "l2");
  assert.equal(trafficAt(index, 10).queues.length, 0);
  assert.equal(trafficAt(index, 10).services[0].nodeId, "l2");
  assert.equal(trafficAt(index, 10).services[0].flow, undefined);
  assert.equal(trafficAt(index, 10).services[0].metadata.requestId, "r1");
  assert.equal(trafficAt(index, 22).services.length, 0);
});
