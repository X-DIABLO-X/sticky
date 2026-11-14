import React, { useEffect, useState, useCallback } from "react";
import type { Agent } from "../../types/models";
import { Bot, MessageSquare, HardDrive, Plus, Check, Trash2, X } from "lucide-react";
import { invokeCommand } from "../../lib/ipc";

export interface AgentListProps {
  agents?: Agent[];
  activeAgentId?: string;
  onSelectAgent?: (agentId: string) => void;
  onOpenChat?: (agent: Agent) => void;
  onCreateAgent?: () => void;
}

export const AgentList: React.FC<AgentListProps> = ({
  agents: propAgents,
  activeAgentId: propActiveAgentId,
  onSelectAgent: propOnSelectAgent,
  onOpenChat: propOnOpenChat,
  onCreateAgent: propOnCreateAgent,
}) => {
  const [internalAgents, setInternalAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("");
  const [newPrompt, setNewPrompt] = useState("");

  const isPropDriven = propAgents !== undefined;
  const agents = isPropDriven ? propAgents : internalAgents;
  const activeAgentId = propActiveAgentId || (agents[0]?.id ?? "");

  const loadAgents = useCallback(async () => {
    if (isPropDriven) return;
    setLoading(true);
    setError(null);
    try {
      const list = await invokeCommand<any[]>("get_agents");
      const mapped: Agent[] = list.map((a) => ({
        id: a.id,
        name: a.name,
        avatar: "🤖",
        role: a.role || "Desktop AI Agent",
        model: "bonsai-2:9b",
        status: "idle",
        memoryCount: 0,
      }));
      setInternalAgents(mapped);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
    } finally {
      setLoading(false);
    }
  }, [isPropDriven]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleSelect = (id: string) => {
    if (propOnSelectAgent) {
      propOnSelectAgent(id);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    if (propOnCreateAgent) {
      propOnCreateAgent();
      setShowCreate(false);
      return;
    }

    try {
      await invokeCommand("create_agent", {
        name: newName.trim(),
        role: newRole.trim() || "Desktop AI Assistant",
        systemPrompt: newPrompt.trim() || "You are a helpful assistant.",
      });
      setNewName("");
      setNewRole("");
      setNewPrompt("");
      setShowCreate(false);
      loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    }
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-2.5 p-1 pr-2 select-none">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Registered Agents ({agents.length})
        </span>
        <button
          onClick={() => {
            if (propOnCreateAgent) {
              propOnCreateAgent();
            } else {
              setShowCreate((v) => !v);
            }
          }}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 text-xs font-medium border border-sky-400/30 transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>New Agent</span>
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {showCreate && !propOnCreateAgent && (
        <form onSubmit={handleCreate} className="p-3 rounded-xl bg-slate-900/90 border border-sky-400/40 space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Agent Name (e.g. Code Reviewer)"
            className="w-full px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
            required
          />
          <input
            type="text"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            placeholder="Role description..."
            className="w-full px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="System prompt..."
            rows={2}
            className="w-full px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 resize-none"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-2 py-1 text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1 rounded bg-sky-500 hover:bg-sky-400 text-xs font-semibold text-slate-950"
            >
              Save Agent
            </button>
          </div>
        </form>
      )}

      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;

        return (
          <div
            key={agent.id}
            onClick={() => handleSelect(agent.id)}
            className={`group relative p-3 rounded-xl border transition-all cursor-pointer ${
              isActive
                ? "bg-sky-500/10 border-sky-400/60 shadow-lg shadow-sky-500/10"
                : "bg-slate-800/40 hover:bg-slate-800/80 border-white/5 hover:border-white/20"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-slate-800 border border-white/10 text-xl shadow-inner shrink-0">
                  <span>{agent.avatar || "🤖"}</span>
                  <span
                    className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-slate-900 ${
                      agent.status === "busy"
                        ? "bg-amber-400 animate-pulse"
                        : agent.status === "scheduled"
                        ? "bg-purple-400"
                        : "bg-emerald-400"
                    }`}
                  />
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-semibold text-slate-100 group-hover:text-sky-300 transition-colors">
                      {agent.name}
                    </h4>
                    {isActive && (
                      <span className="flex items-center gap-0.5 px-1.5 py-0.2 rounded-full bg-sky-500 text-[10px] font-bold text-slate-950">
                        <Check className="w-2.5 h-2.5" /> Active
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{agent.role}</p>

                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-slate-300 font-mono">
                      {agent.model}
                    </span>

                    {agent.memoryCount !== undefined && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-400">
                        <HardDrive className="w-3 h-3 text-slate-400" />
                        {agent.memoryCount} memories
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {propOnOpenChat && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    propOnOpenChat(agent);
                  }}
                  className="p-2 rounded-lg bg-white/5 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-white/5 transition-colors shrink-0"
                  title="Open Agent Conversation"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
