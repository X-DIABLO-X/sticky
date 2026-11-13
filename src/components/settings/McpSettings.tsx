import React, { useState } from "react";
import type { McpServerConfig } from "../../types/models";
import { Server, Plus, CheckCircle2, XCircle, Trash2, Globe, Terminal, RefreshCw } from "lucide-react";

interface McpSettingsProps {
  servers: McpServerConfig[];
  onAddServer: (server: McpServerConfig) => void;
  onRemoveServer: (serverId: string) => void;
  onTestConnection: (serverId: string) => Promise<boolean>;
}

export const McpSettings: React.FC<McpSettingsProps> = ({
  servers,
  onAddServer,
  onRemoveServer,
  onTestConnection,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [argsStr, setArgsStr] = useState("");
  const [url, setUrl] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const newServer: McpServerConfig = {
      id: `mcp-${Date.now()}`,
      name,
      transport,
      command: transport === "stdio" ? command : undefined,
      args: transport === "stdio" ? argsStr.split(" ").filter((s) => s.trim().length > 0) : undefined,
      url: transport === "sse" ? url : undefined,
      status: "connected",
      toolsCount: 5,
    };

    onAddServer(newServer);
    setName("");
    setCommand("");
    setArgsStr("");
    setUrl("");
    setShowAddForm(false);
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    await onTestConnection(id);
    setTestingId(null);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-3 p-1 pr-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          MCP Servers ({servers.length})
        </span>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 text-xs font-semibold border border-sky-400/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add Server</span>
        </button>
      </div>

      {/* Add Server Form */}
      {showAddForm && (
        <form
          onSubmit={handleAdd}
          className="p-3.5 rounded-xl bg-slate-800/80 border border-sky-400/40 shadow-xl space-y-2.5 animate-float"
        >
          <div className="text-xs font-bold text-sky-300">Register Model Context Protocol (MCP) Server</div>

          <div>
            <label className="text-[10px] text-slate-400 font-medium">Server Display Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Postgres DB Explorer or GitHub MCP"
              className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
              required
            />
          </div>

          <div>
            <label className="text-[10px] text-slate-400 font-medium">Transport Protocol</label>
            <div className="flex gap-3 mt-1 text-xs text-slate-300">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="transport"
                  value="stdio"
                  checked={transport === "stdio"}
                  onChange={() => setTransport("stdio")}
                />
                <span>stdio (Local Binary / npx)</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  name="transport"
                  value="sse"
                  checked={transport === "sse"}
                  onChange={() => setTransport("sse")}
                />
                <span>SSE / HTTP (Remote Endpoint)</span>
              </label>
            </div>
          </div>

          {transport === "stdio" ? (
            <>
              <div>
                <label className="text-[10px] text-slate-400 font-medium">Command Executable</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="e.g. npx or docker"
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-sky-400"
                  required
                />
              </div>

              <div>
                <label className="text-[10px] text-slate-400 font-medium">Arguments (space-separated)</label>
                <input
                  type="text"
                  value={argsStr}
                  onChange={(e) => setArgsStr(e.target.value)}
                  placeholder="e.g. -y @modelcontextprotocol/server-postgres postgresql://..."
                  className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-sky-400"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="text-[10px] text-slate-400 font-medium">Remote Server SSE URL</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.internal.company.com/sse"
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white font-mono placeholder-slate-500 focus:outline-none focus:border-sky-400"
                required
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-2.5 py-1 rounded text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1 rounded bg-sky-500 hover:bg-sky-400 text-xs font-semibold text-slate-950 shadow"
            >
              Connect Server
            </button>
          </div>
        </form>
      )}

      {/* Server List */}
      {servers.map((srv) => (
        <div
          key={srv.id}
          className="p-3 rounded-xl bg-slate-800/40 border border-white/5 space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <div className="p-2 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-400/30 shrink-0">
                {srv.transport === "stdio" ? (
                  <Terminal className="w-4 h-4" />
                ) : (
                  <Globe className="w-4 h-4" />
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-slate-200">{srv.name}</h4>
                  <span className="text-[10px] uppercase font-bold px-1.5 py-0.2 rounded bg-white/5 border border-white/10 text-slate-400 font-mono">
                    {srv.transport}
                  </span>
                </div>

                <div className="text-[11px] text-slate-400 font-mono mt-0.5 break-all">
                  {srv.transport === "stdio"
                    ? `${srv.command} ${(srv.args || []).join(" ")}`
                    : srv.url}
                </div>

                <div className="flex items-center gap-3 mt-1.5 text-[10px]">
                  <span className="flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Connected ({srv.toolsCount ?? 0} tools registered)</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                onClick={() => handleTest(srv.id)}
                disabled={testingId === srv.id}
                className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/20 text-slate-400 hover:text-sky-400 transition-colors"
                title="Test Ping"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${testingId === srv.id ? "animate-spin text-sky-400" : ""}`}
                />
              </button>

              <button
                onClick={() => onRemoveServer(srv.id)}
                className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
