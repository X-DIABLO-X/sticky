import React from "react";
import type { Agent } from "../../types/models";
import { Bot, MessageSquare, HardDrive, Plus, Check } from "lucide-react";

interface AgentListProps {
  agents: Agent[];
  activeAgentId: string;
  onSelectAgent: (agentId: string) => void;
  onOpenChat: (agent: Agent) => void;
  onCreateAgent?: () => void;
}

export const AgentList: React.FC<AgentListProps> = ({
  agents,
  activeAgentId,
  onSelectAgent,
  onOpenChat,
  onCreateAgent,
}) => {
  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-2.5 p-1 pr-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Registered Clickys ({agents.length})
        </span>
        <button
          onClick={onCreateAgent}
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 text-xs font-medium border border-sky-400/30 transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>New Clicky</span>
        </button>
      </div>

      {agents.map((agent) => {
        const isActive = agent.id === activeAgentId;

        return (
          <div
            key={agent.id}
            onClick={() => onSelectAgent(agent.id)}
            className={`group relative p-3 rounded-xl border transition-all cursor-pointer ${
              isActive
                ? "bg-sky-500/10 border-sky-400/60 shadow-lg shadow-sky-500/10"
                : "bg-slate-800/40 hover:bg-slate-800/80 border-white/5 hover:border-white/20"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              {/* Avatar & Info */}
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

              {/* Action Buttons */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChat(agent);
                }}
                className="p-2 rounded-lg bg-white/5 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 border border-white/5 transition-colors shrink-0"
                title="Open Agent Conversation & Workspace"
              >
                <MessageSquare className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
