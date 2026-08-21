// rebac-engine.js - Relationship-Based Access Control Graph Engine
// Provides multi-hop relational authorization for entities, resources, and agents.

class ReBACEngine {
  constructor() {
    this.nodes = new Map(); // id -> { id, label, props }
    this.edges = [];        // Array of { from, relation, to }
  }

  addNode(id, label, props = {}) {
    this.nodes.set(id, { id, label, props });
  }

  addEdge(fromId, relation, toId) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) {
      throw new Error(`Invalid edge connection: ${fromId} -> ${toId}`);
    }
    this.edges.push({ from: fromId, relation, to: toId });
  }

  /**
   * Evaluates if actorId has capability for `action` on `resourceId` by traversing relation edges.
   */
  canAccess(actorId, action, resourceId) {
    const visited = new Set();
    const queue = [{ nodeId: actorId, path: [actorId] }];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift();

      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      // 1. Direct Ownership or Role Capability matching target resource
      const targetEdges = this.edges.filter(
        e => e.from === nodeId && (e.relation === 'OWNER_OF' || e.relation === 'INCLUDES' || e.relation === 'APPLIES_TO')
      );

      for (const edge of targetEdges) {
        if (edge.to === resourceId && this._nodeHasAction(nodeId, resourceId, action)) {
          return { authorized: true, path: [...path, `${edge.relation}->`, resourceId] };
        }
      }

      // 2. Traversal through hierarchy & assignment edges (MEMBER_OF, PARENT_OF, GRANTED, DELEGATED_TO)
      const outgoing = this.edges.filter(e => e.from === nodeId);
      for (const edge of outgoing) {
        if (!visited.has(edge.to)) {
          queue.push({ nodeId: edge.to, path: [...path, `${edge.relation}->`, edge.to] });
        }
      }
    }

    return { authorized: false, path: [] };
  }

  _nodeHasAction(nodeId, resourceId, action) {
    const node = this.nodes.get(nodeId);
    const resource = this.nodes.get(resourceId);
    
    // Direct owner automatically granted
    const isOwner = this.edges.some(e => e.from === nodeId && e.to === resourceId && e.relation === 'OWNER_OF');
    if (isOwner) return true;

    if (node && (node.props.action === action || node.props.action === '*')) {
      return true;
    }
    if (resource && (resource.props.action === action || resource.props.action === '*')) {
      return true;
    }
    return false;
  }

}

module.exports = ReBACEngine;
