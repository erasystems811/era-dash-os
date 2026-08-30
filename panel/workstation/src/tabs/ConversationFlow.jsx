import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, applyNodeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Same canvas as ebos-templates/dashboard/client/src/pages/TrainTheBot.jsx,
// duplicated rather than shared -- the two apps aren't wired into one
// package, and this component is small enough that a shared-package setup
// would cost more than it saves right now. If a third place needs it,
// that's the point to factor it out for real.
export default function ConversationFlow({ botStates, setBotStates }) {
  const nodes = useMemo(
    () =>
      botStates.map((s) => ({
        id: s.key,
        position: { x: s.position_x || 0, y: s.position_y || 0 },
        data: { label: s.label },
        style: { borderRadius: 10, border: '1px solid #e5e7eb', padding: 4, fontSize: 12.5, fontWeight: 600 },
      })),
    [botStates]
  );
  const edges = useMemo(
    () => botStates.flatMap((s) => (s.allowed_next || []).map((target) => ({ id: `${s.key}->${target}`, source: s.key, target }))),
    [botStates]
  );

  const [nodeState, setNodeState] = useState(nodes);
  useEffect(() => setNodeState(nodes), [nodes]);

  const onNodesChange = useCallback((changes) => setNodeState((nds) => applyNodeChanges(changes, nds)), []);

  const onNodeDragStop = useCallback(
    (event, node) => {
      setBotStates((prev) => prev.map((s) => (s.key === node.id ? { ...s, position_x: node.position.x, position_y: node.position.y } : s)));
    },
    [setBotStates]
  );

  const onConnect = useCallback(
    (connection) => {
      setBotStates((prev) =>
        prev.map((s) => (s.key === connection.source ? { ...s, allowed_next: Array.from(new Set([...(s.allowed_next || []), connection.target])) } : s))
      );
    },
    [setBotStates]
  );

  const onEdgesDelete = useCallback(
    (deleted) => {
      setBotStates((prev) => {
        let next = prev;
        for (const edge of deleted) {
          next = next.map((s) => (s.key === edge.source ? { ...s, allowed_next: (s.allowed_next || []).filter((k) => k !== edge.target) } : s));
        }
        return next;
      });
    },
    [setBotStates]
  );

  return (
    <div>
      <h1>Conversation flow</h1>
      <p className="subtitle">
        Drag a box to reposition. Drag from one box's edge to another to allow that move. Click a connecting line and press delete to remove it. Starts from the standard 10-step flow every EBOS business uses.
      </p>
      <div className="card" style={{ padding: 0 }}>
        <div style={{ height: 560, borderRadius: 10, background: '#fafafa' }}>
          <ReactFlow
            nodes={nodeState}
            edges={edges}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
