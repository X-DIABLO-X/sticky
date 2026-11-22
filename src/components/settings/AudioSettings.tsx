import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Mic, Play, RefreshCw, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { invokeCommand } from "../../lib/ipc";
import { Badge, Button, Card } from "../ui/primitives";

export interface AudioDeviceInfo {
  name: string;
  is_default: boolean;
}

export interface AudioDevicesPayload {
  inputs: AudioDeviceInfo[];
  outputs: AudioDeviceInfo[];
  selected_input: string | null;
  selected_output: string | null;
}

export const AudioSettings: React.FC = () => {
  const [inputs, setInputs] = useState<AudioDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<AudioDeviceInfo[]>([]);
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const [selectedOutput, setSelectedOutput] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isTestingTts, setIsTestingTts] = useState<boolean>(false);
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null);

  const selectedInputRef = useRef<string | null>(null);
  const selectedOutputRef = useRef<string | null>(null);

  const loadDevices = useCallback(async (showToast = false) => {
    setIsLoading(true);
    try {
      const payload = await invokeCommand<AudioDevicesPayload>("list_audio_devices");
      const nextInputs = Array.isArray(payload?.inputs) ? payload.inputs : [];
      const nextOutputs = Array.isArray(payload?.outputs) ? payload.outputs : [];
      const nextSelectedInput = payload?.selected_input ?? null;
      const nextSelectedOutput = payload?.selected_output ?? null;

      setInputs(nextInputs);
      setOutputs(nextOutputs);
      setSelectedInput(nextSelectedInput);
      setSelectedOutput(nextSelectedOutput);
      selectedInputRef.current = nextSelectedInput;
      selectedOutputRef.current = nextSelectedOutput;

      if (showToast) {
        toast.success("Audio devices refreshed", {
          description: `${nextInputs.length} ${nextInputs.length === 1 ? "microphone" : "microphones"} · ${nextOutputs.length} ${nextOutputs.length === 1 ? "output" : "outputs"}`,
        });
      }
    } catch (err) {
      toast.error("Failed to load audio devices", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDevices(false);
  }, [loadDevices]);

  const handleInputChange = async (rawValue: string) => {
    const nextInput = rawValue === "" ? null : rawValue;
    const prevInput = selectedInputRef.current;
    const currentOutput = selectedOutputRef.current;

    setSelectedInput(nextInput);
    selectedInputRef.current = nextInput;
    setIsSaving(true);

    try {
      await invokeCommand<void>("set_audio_devices", {
        inputDevice: nextInput,
        outputDevice: currentOutput,
      });
      toast.success("Microphone updated", {
        description: nextInput ?? "System Default",
      });
    } catch (err) {
      setSelectedInput(prevInput);
      selectedInputRef.current = prevInput;
      toast.error("Failed to switch microphone", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleOutputChange = async (rawValue: string) => {
    const nextOutput = rawValue === "" ? null : rawValue;
    const prevOutput = selectedOutputRef.current;
    const currentInput = selectedInputRef.current;

    setSelectedOutput(nextOutput);
    selectedOutputRef.current = nextOutput;
    setIsSaving(true);

    try {
      await invokeCommand<void>("set_audio_devices", {
        inputDevice: currentInput,
        outputDevice: nextOutput,
      });
      toast.success("Speaker output hot-swapped", {
        description: nextOutput ?? "System Default",
      });
    } catch (err) {
      setSelectedOutput(prevOutput);
      selectedOutputRef.current = prevOutput;
      toast.error("Failed to switch speaker output", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestTts = async () => {
    setIsTestingTts(true);
    try {
      const latencyMs = await invokeCommand<number>("test_tts_output", {
        text: "Sticky audio check. Realtime voice is ready.",
      });
      const roundedMs = typeof latencyMs === "number" && Number.isFinite(latencyMs)
        ? Math.round(latencyMs)
        : 0;
      setLastLatencyMs(roundedMs);
      toast.success(`Spoke in ${roundedMs}ms`, {
        description: selectedOutput ?? "System Default speaker",
      });
    } catch (err) {
      toast.error("Speaker & voice test failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsTestingTts(false);
    }
  };

  const defaultInput = inputs.find((d) => d.is_default);
  const defaultOutput = outputs.find((d) => d.is_default);
  const isSelectedInputDisconnected =
    selectedInput !== null && !inputs.some((d) => d.name === selectedInput);
  const isSelectedOutputDisconnected =
    selectedOutput !== null && !outputs.some((d) => d.name === selectedOutput);

  return (
    <Card className="p-5 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <Volume2 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100 tracking-tight">
              Audio Devices & Realtime Voice
            </h2>
            <p className="text-xs text-zinc-400">
              Choose your microphone and speaker output. Output switches live with zero restart.
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => loadDevices(true)}
          disabled={isLoading || isSaving}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          Refresh Devices
        </Button>
      </div>

      {/* 2-Column Device Selector Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Microphone (Input) */}
        <div className="rounded-xl bg-[#0f1115] border border-white/[0.07] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="sticky-audio-input-select"
              className="flex items-center gap-2 text-xs font-medium text-zinc-200"
            >
              <Mic className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Microphone (Input)</span>
            </label>
            <Badge tone={selectedInput ? "info" : "neutral"}>
              {selectedInput ? "Custom" : "System Default"}
            </Badge>
          </div>

          <select
            id="sticky-audio-input-select"
            value={selectedInput ?? ""}
            onChange={(e) => handleInputChange(e.target.value)}
            disabled={isLoading || isSaving}
            className="w-full rounded-lg bg-[#161920] border border-white/[0.1] px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/40 hover:border-white/[0.18] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="" className="bg-[#13151a] text-zinc-100">
              System Default
            </option>
            {isSelectedInputDisconnected && (
              <option value={selectedInput} className="bg-[#13151a] text-amber-300">
                {selectedInput} (Disconnected)
              </option>
            )}
            {inputs.map((device, idx) => (
              <option
                key={`${device.name}-${idx}`}
                value={device.name}
                className="bg-[#13151a] text-zinc-100"
              >
                {device.name}
                {device.is_default ? " (OS Default)" : ""}
              </option>
            ))}
          </select>

          <p className="text-[11px] text-zinc-500 truncate">
            {defaultInput
              ? `OS Default: ${defaultInput.name}`
              : `${inputs.length} input ${inputs.length === 1 ? "device" : "devices"} detected`}
          </p>
        </div>

        {/* Speaker / Headphones (Output) */}
        <div className="rounded-xl bg-[#0f1115] border border-white/[0.07] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="sticky-audio-output-select"
              className="flex items-center gap-2 text-xs font-medium text-zinc-200"
            >
              <Volume2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Speaker / Headphones (Output)</span>
            </label>
            <Badge tone={selectedOutput ? "success" : "neutral"}>
              {selectedOutput ? "Hot-Swapped" : "System Default"}
            </Badge>
          </div>

          <select
            id="sticky-audio-output-select"
            value={selectedOutput ?? ""}
            onChange={(e) => handleOutputChange(e.target.value)}
            disabled={isLoading || isSaving}
            className="w-full rounded-lg bg-[#161920] border border-white/[0.1] px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-blue-500/70 focus:ring-1 focus:ring-blue-500/40 hover:border-white/[0.18] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="" className="bg-[#13151a] text-zinc-100">
              System Default
            </option>
            {isSelectedOutputDisconnected && (
              <option value={selectedOutput} className="bg-[#13151a] text-amber-300">
                {selectedOutput} (Disconnected)
              </option>
            )}
            {outputs.map((device, idx) => (
              <option
                key={`${device.name}-${idx}`}
                value={device.name}
                className="bg-[#13151a] text-zinc-100"
              >
                {device.name}
                {device.is_default ? " (OS Default)" : ""}
              </option>
            ))}
          </select>

          <p className="text-[11px] text-zinc-500 truncate">
            {defaultOutput
              ? `OS Default: ${defaultOutput.name}`
              : `${outputs.length} output ${outputs.length === 1 ? "device" : "devices"} detected`}
          </p>
        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-2.5 flex-wrap">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleTestTts}
            disabled={isTestingTts || isLoading || isSaving}
          >
            {isTestingTts ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
            {isTestingTts ? "Testing Voice..." : "Test Speaker & Voice Speed"}
          </Button>

          {lastLatencyMs !== null && (
            <Badge tone="success">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Spoke in {lastLatencyMs}ms
            </Badge>
          )}
        </div>

        <span className="text-[11px] text-zinc-500">
          Live sink hot-swap · No restart required
        </span>
      </div>
    </Card>
  );
};
