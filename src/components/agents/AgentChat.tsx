import React, { useState } from "react";
import type { Agent } from "../../types/models";
import type { ToolCall } from "../../types/tools";
import { Send, FileCode, Folder, ChevronDown, ChevronRight, ArrowLeft, Terminal, Bot, User } from "lucide-react";

interface ChatMessage {
  id: string;
  sender: "user" | "clicky";
  text: string;
  timestamp: string;
  toolCalls?: ToolCall[];
}

interface AgentChatProps {
  agent: Agent;
  onBack: () => void;
}

export const AgentChat: React.FC<AgentChatProps> = ({ agent, onBack }) => {
  const [activeTab, setActiveTab] = useState<"chat" | "workspace">("chat");
  const [inputMessage, setInputMessage] = useState("");
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "msg-1",
      sender: "user",
      text: "Can you analyze the architecture of D:\\cliky and verify the spatial overlay pipeline?",
      timestamp: "10:20 AM",
    },
    {
      id: "msg-2",
      sender: "clicky",
      text: "I have inspected the project workspace. The multi-window configuration routes 4 transparent windows, with full 420ms Bezier smoothing and roughjs sketches configured.",
      timestamp: "10:21 AM",
      toolCalls: [
        {
          id: "tool-1",
          name: "get_a11y_tree",
          parameters: { max_depth: 8 },
          status: "completed",
          result: { nodeCount: 42, focusedWindow: "Code - OSS" },
        },
      ],
    },
  ]);

  const workspaceFiles = [
    { name: "folders.md", path: "docs/02-architecture/folders.md", size: "4.8 KB", type: "doc" },
    { name: "ui-ux-overlay.md", path: "docs/04-implementation/ui-ux-overlay.md", size: "2.1 KB", type: "doc" },
    { name: "bezier.ts", path: "src/lib/bezier.ts", size: "3.2 KB", type: "code" },
    { name: "pointParser.ts", path: "src/lib/pointParser.ts", size: "4.6 KB", type: "code" },
  ];

  const handleSendMessage = () => {
    if (!inputMessage.trim()) return;

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      sender: "user",
      text: inputMessage,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMessage("");

    // Simulate Agent response
    setTimeout(() => {
      const clickyReply: ChatMessage = {
        id: `msg-${Date.now() + 1}`,
        sender: "clicky",
        text: `Executing on [${agent.name}]: I'm processing your request using model ${agent.model}.`,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, clickyReply]);
    }, 600);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Chat Header */}
      <div className="flex items-center justify-between pb-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-lg">{agent.avatar}</span>
          <div>
            <h4 className="text-xs font-bold text-slate-100">{agent.name}</h4>
            <span className="text-[10px] text-sky-400 font-mono">{agent.model}</span>
          </div>
        </div>

        {/* Tab switcher: Chat vs Workspace */}
        <div className="flex rounded-lg bg-black/40 p-0.5 border border-white/5">
          <button
            onClick={() => setActiveTab("chat")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
              activeTab === "chat" ? "bg-sky-500 text-slate-950 shadow" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Chat
          </button>
          <button
            onClick={() => setActiveTab("workspace")}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
              activeTab === "workspace" ? "bg-sky-500 text-slate-950 shadow" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Workspace
          </button>
        </div>
      </div>

      {/* Main Tab Content */}
      {activeTab === "chat" ? (
        <div className="flex flex-col flex-1 overflow-hidden mt-3">
          {/* Messages Scroll Area */}
          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {messages.map((msg) => {
              const isUser = msg.sender === "user";
              return (
                <div
                  key={msg.id}
                  className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}
                >
                  <div
                    className={`flex items-center justify-center w-7 h-7 rounded-lg shrink-0 text-xs ${
                      isUser
                        ? "bg-sky-500/20 text-sky-400 border border-sky-400/30"
                        : "bg-slate-800 text-slate-300 border border-white/10"
                    }`}
                  >
                    {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                  </div>

                  <div
                    className={`max-w-[82%] rounded-xl p-3 text-xs leading-relaxed ${
                      isUser
                        ? "bg-sky-600 text-white rounded-tr-none shadow-md"
                        : "glass-card text-slate-200 rounded-tl-none border border-white/10"
                    }`}
                  >
                    <p>{msg.text}</p>

                    {/* Tool Calls Inspector */}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mt-2.5 space-y-1.5 pt-2 border-t border-white/10">
                        {msg.toolCalls.map((tc) => {
                          const isExpanded = expandedToolId === tc.id;
                          return (
                            <div
                              key={tc.id}
                              className="rounded-lg bg-black/40 border border-white/10 overflow-hidden text-[11px]"
                            >
                              <div
                                onClick={() => setExpandedToolId(isExpanded ? null : tc.id)}
                                className="flex items-center justify-between p-1.5 cursor-pointer hover:bg-white/5 transition-colors font-mono"
                              >
                                <span className="flex items-center gap-1.5 text-amber-400">
                                  <Terminal className="w-3 h-3" />
                                  <span>{tc.name}()</span>
                                </span>
                                {isExpanded ? (
                                  <ChevronDown className="w-3 h-3 text-slate-400" />
                                ) : (
                                  <ChevronRight className="w-3 h-3 text-slate-400" />
                                )}
                              </div>

                              {isExpanded && (
                                <div className="p-2 border-t border-white/10 bg-black/60 font-mono text-[10px] space-y-1">
                                  <div className="text-slate-400">Args:</div>
                                  <pre className="text-sky-300 overflow-x-auto">
                                    {JSON.stringify(tc.parameters, null, 2)}
                                  </pre>
                                  {tc.result && (
                                    <>
                                      <div className="text-slate-400 mt-1">Result:</div>
                                      <pre className="text-emerald-300 overflow-x-auto">
                                        {JSON.stringify(tc.result, null, 2)}
                                      </pre>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <span className="block text-[9px] text-slate-400 mt-1 text-right">
                      {msg.timestamp}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Chat Input Bar */}
          <div className="pt-3 border-t border-white/10 shrink-0">
            <div className="flex items-center gap-2 rounded-xl bg-slate-900/90 border border-white/10 px-3 py-1.5 focus-within:border-sky-400/60 transition-colors">
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                placeholder={`Message ${agent.name}...`}
                className="flex-1 bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none"
              />
              <button
                onClick={handleSendMessage}
                disabled={!inputMessage.trim()}
                className="p-1 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-30 disabled:pointer-events-none text-slate-950 transition-all"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Workspace File Browser View */
        <div className="flex flex-col flex-1 overflow-hidden mt-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400 mb-2">
            <Folder className="w-3.5 h-3.5 text-sky-400" />
            <span className="font-mono">{agent.workspacePath || "D:\\cliky"}</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {workspaceFiles.map((file, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800/40 hover:bg-slate-800/80 border border-white/5 hover:border-white/15 transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-sky-400" />
                  <div>
                    <div className="text-xs font-medium text-slate-200">{file.name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">{file.path}</div>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 font-mono">{file.size}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
