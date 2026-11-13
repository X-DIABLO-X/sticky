import React, { useState } from "react";
import type { CronJob, Agent } from "../../types/models";
import { Clock, Plus, Play, ToggleLeft, ToggleRight, Trash2, Calendar, Sparkles } from "lucide-react";

interface CronManagerProps {
  cronJobs: CronJob[];
  agents: Agent[];
  onToggleJob: (jobId: string, enabled: boolean) => void;
  onRunNow: (jobId: string) => void;
  onAddJob: (job: Omit<CronJob, "id">) => void;
  onDeleteJob: (jobId: string) => void;
}

export const CronManager: React.FC<CronManagerProps> = ({
  cronJobs,
  agents,
  onToggleJob,
  onRunNow,
  onAddJob,
  onDeleteJob,
}) => {
  const [showCreator, setShowCreator] = useState(false);
  const [naturalSchedule, setNaturalSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id || "clicky-routine");

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!naturalSchedule.trim() || !prompt.trim()) return;

    // Simple deterministic cron heuristic or fallback
    let schedule = "0 9 * * *";
    const lower = naturalSchedule.toLowerCase();
    if (lower.includes("hourly") || lower.includes("every hour")) {
      schedule = "0 * * * *";
    } else if (lower.includes("weekday")) {
      schedule = "0 9 * * 1-5";
    } else if (lower.includes("friday")) {
      schedule = "0 18 * * 5";
    } else if (lower.includes("midnight") || lower.includes("every night")) {
      schedule = "0 0 * * *";
    }

    onAddJob({
      agentId: selectedAgentId,
      schedule,
      naturalSchedule,
      prompt,
      nextRun: "Scheduled upcoming",
      enabled: true,
    });

    setNaturalSchedule("");
    setPrompt("");
    setShowCreator(false);
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto space-y-3 p-1 pr-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
          Automated Routines ({cronJobs.length})
        </span>
        <button
          onClick={() => setShowCreator(!showCreator)}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-sky-400 text-xs font-semibold border border-sky-400/30 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Routine</span>
        </button>
      </div>

      {/* Natural Language Routine Creator */}
      {showCreator && (
        <form
          onSubmit={handleCreate}
          className="p-3.5 rounded-xl bg-slate-800/80 border border-sky-400/40 shadow-xl space-y-2.5 animate-float"
        >
          <div className="flex items-center gap-1.5 text-xs font-bold text-sky-300">
            <Sparkles className="w-3.5 h-3.5 text-sky-400" />
            <span>Create Routine with Natural Language</span>
          </div>

          <div>
            <label className="text-[10px] text-slate-400 font-medium">When should it run?</label>
            <input
              type="text"
              value={naturalSchedule}
              onChange={(e) => setNaturalSchedule(e.target.value)}
              placeholder="e.g. Every weekday at 9:00 AM"
              className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400"
              required
            />
          </div>

          <div>
            <label className="text-[10px] text-slate-400 font-medium">Which Clicky?</label>
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="w-full mt-0.5 px-2 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white focus:outline-none focus:border-sky-400"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id} className="bg-slate-900">
                  {a.avatar} {a.name} ({a.model})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-slate-400 font-medium">What should it do?</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Summarize overnight git activity and draft standup notes."
              rows={2}
              className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-black/40 border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-400 resize-none"
              required
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowCreator(false)}
              className="px-2.5 py-1 rounded text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-3 py-1 rounded bg-sky-500 hover:bg-sky-400 text-xs font-semibold text-slate-950 shadow"
            >
              Save Schedule
            </button>
          </div>
        </form>
      )}

      {/* Routine List */}
      {cronJobs.map((job) => {
        const agent = agents.find((a) => a.id === job.agentId);

        return (
          <div
            key={job.id}
            className={`p-3 rounded-xl border transition-all ${
              job.enabled
                ? "bg-slate-800/60 border-white/10 shadow-sm"
                : "bg-slate-900/40 border-white/5 opacity-60"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400 border border-purple-500/30 shrink-0">
                  <Clock className="w-4 h-4" />
                </div>

                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-bold text-slate-200">{job.naturalSchedule}</h4>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-white/5 border border-white/10 text-slate-400 font-mono">
                      {job.schedule}
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 mt-1 line-clamp-2">{job.prompt}</p>

                  <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span>{agent?.avatar || "🤖"}</span>
                      <span>{agent?.name || "Automator"}</span>
                    </span>

                    {job.nextRun && (
                      <span className="flex items-center gap-1 text-sky-400">
                        <Calendar className="w-3 h-3" />
                        <span>Next: {job.nextRun}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => onRunNow(job.id)}
                  className="p-1.5 rounded-lg bg-white/5 hover:bg-sky-500/20 text-slate-300 hover:text-sky-400 transition-colors"
                  title="Run now immediately"
                >
                  <Play className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={() => onToggleJob(job.id, !job.enabled)}
                  className="p-1 text-slate-400 hover:text-white transition-colors"
                  title={job.enabled ? "Disable routine" : "Enable routine"}
                >
                  {job.enabled ? (
                    <ToggleRight className="w-5 h-5 text-sky-400" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-slate-500" />
                  )}
                </button>

                <button
                  onClick={() => onDeleteJob(job.id)}
                  className="p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
