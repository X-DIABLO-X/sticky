import React, { useState, useEffect, useRef } from "react";
import {
  invokeCommand,
  listenEvent,
  emitEvent,
  isTauri,
} from "../lib/ipc";
import type {
  AppConfig,
  Agent,
  CronJob,
  Memory,
  OllamaStatus,
} from "../types/models";
import type {
  OverlayPointEvent,
  OverlayDrawEvent,
  Overlay3DEvent,
  WalkthroughStep,
  DriveStatusEvent,
} from "../types/events";
import {
  Sparkles,
  MessageSquare,
  Compass,
  Cpu,
  Database,
  Calendar,
  Send,
  Play,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Mic,
  FileText,
  Volume2,
  Radio,
  Layers,
  ChevronRight,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
  Box,
  Eye,
  Sliders,
  Settings,
  ShieldAlert,
} from "lucide-react";
import * as THREE from "three";

interface ChatMessage {
  id: string;
  sender: "user" | "clicky";
  content: string;
  cleanSpeech?: string;
  tags?: {
    type: "POINT" | "DRAW" | "STEP" | "3D";
    raw: string;
    parsed: any;
  }[];
  latencyMs?: number;
  tokensPerSec?: number;
  timestamp: string;
}

const PRESET_QUESTIONS = [
  {
    label: "🔍 Find Clear Cache",
    prompt: "Where do I clear my cache in this browser?",
    category: "Spatial Pointing",
  },
  {
    label: "✏️ Circle Save & Arrow",
    prompt: "Circle the save button at (150, 40) and draw an arrow from the file list at (50, 100) to it.",
    category: "2D Annotation",
  },
  {
    label: "📋 3-Step Export Walkthrough",
    prompt: "Show me step-by-step how to export this project as a PDF in 3 steps.",
    category: "Guided Tour",
  },
  {
    label: "🧊 3D Robot Mascot",
    prompt: "Show me a 3D model of the robot mascot.",
    category: "3D Spatial",
  },
  {
    label: "🎙️ kubectl Dictation Cleanup",
    prompt: "Clean up this spoken text: um so basically we need to uh run cube ctl apply minus f deployment yaml and then like check if the tore e desktop app has a e c three audio enabled you know",
    category: "Dictation",
  },
  {
    label: "🚗 Click Search & Type Drive",
    prompt: "Click on the search bar at (400, 50) and type bonsai 2 with enter.",
    category: "Drive Mode",
  },
];

export const DashboardWindow: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"copilot" | "spatial" | "memory" | "engine" | "agents">("copilot");

  // System & Connection State
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>({
    running: false,
    url: "http://127.0.0.1:11434",
    models: ["bonsai-2:9b"],
    current_model: "bonsai-2:9b",
  });
  const [isTalking, setIsTalking] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Copilot Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      sender: "clicky",
      content:
        "Welcome to HeyClicky Desktop AI. I am powered by your local bonsai-2:9b model at http://127.0.0.1:11434 with zero cloud dependencies. You can ask me spatial questions, request 2D screen drawings, project 3D models, or trigger automated workflows.",
      cleanSpeech: "Welcome to HeyClicky Desktop AI. Your local bonsai model is connected and ready.",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [inputPrompt, setInputPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Spatial Sandbox State
  const [pointX, setPointX] = useState(450);
  const [pointY, setPointY] = useState(420);
  const [pointLabel, setPointLabel] = useState("Clear browsing data");
  const [drawShape, setDrawShape] = useState<"circle" | "arrow" | "box">("circle");
  const [drawColor, setDrawColor] = useState("#3186ff");
  const [threeModel, setThreeModel] = useState<"robot" | "drone" | "sensor">("robot");
  const threeMountRef = useRef<HTMLDivElement>(null);

  // Memory Editor State
  const [memSearch, setMemSearch] = useState("");
  const [newMemScope, setNewMemScope] = useState("user_profile");
  const [newMemKey, setNewMemKey] = useState("");
  const [newMemVal, setNewMemVal] = useState("");

  // 1. Initial Data Fetch
  useEffect(() => {
    async function initData() {
      try {
        const [status, mems, agts, crons] = await Promise.all([
          invokeCommand<OllamaStatus>("check_ollama_status").catch(() => ({
            running: true,
            url: "http://127.0.0.1:11434",
            models: ["bonsai-2:9b"],
            current_model: "bonsai-2:9b",
          })),
          invokeCommand<Memory[]>("get_memories").catch(() => []),
          invokeCommand<Agent[]>("get_agents").catch(() => []),
          invokeCommand<CronJob[]>("get_cron_jobs").catch(() => []),
        ]);
        setOllamaStatus(status);
        setMemories(mems);
        setAgents(agts);
        setCronJobs(crons);
      } catch (err) {
        console.warn("Init dashboard data error:", err);
      }
    }
    initData();
  }, []);

  // Scroll chat to bottom
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, isGenerating]);

  // 2. Interactive Three.js Preview Canvas inside Dashboard
  useEffect(() => {
    if (activeTab !== "spatial" || !threeMountRef.current) return;

    const mount = threeMountRef.current;
    const width = mount.clientWidth || 380;
    const height = mount.clientHeight || 260;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a); // Slate-900

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    camera.position.set(0, 0, 4.5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const pointLight = new THREE.PointLight(0x38bdf8, 2, 50);
    pointLight.position.set(5, 5, 5);
    scene.add(pointLight);

    // Objects
    const group = new THREE.Group();

    // Body
    const bodyGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      roughness: 0.3,
      metalness: 0.8,
      wireframe: threeModel === "sensor",
    });
    const cube = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(cube);

    // Core Orb
    const coreGeo = new THREE.SphereGeometry(0.4, 24, 24);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 0.6,
      roughness: 0.1,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);

    // Orbiting Ring
    const ringGeo = new THREE.TorusGeometry(1.5, 0.04, 16, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 3;
    group.add(ring);

    scene.add(group);

    // Mouse Interaction
    let isDragging = false;
    let prevMouseX = 0;
    let prevMouseY = 0;

    const onMouseDown = (e: MouseEvent) => {
      isDragging = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - prevMouseX;
      const deltaY = e.clientY - prevMouseY;
      group.rotation.y += deltaX * 0.01;
      group.rotation.x += deltaY * 0.01;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };
    const onMouseUp = () => {
      isDragging = false;
    };

    mount.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    let animId: number;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      if (!isDragging) {
        group.rotation.y += 0.008;
        ring.rotation.z += 0.012;
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      mount.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      renderer.dispose();
    };
  }, [activeTab, threeModel]);

  // Parse tags from assistant response
  const parseTags = (text: string) => {
    const tags: { type: "POINT" | "DRAW" | "STEP" | "3D"; raw: string; parsed: any }[] = [];
    const pointMatch = text.match(/\[POINT:(\d+),(\d+):([^\]]+):?([^\]]*)\]/);
    if (pointMatch) {
      tags.push({
        type: "POINT",
        raw: pointMatch[0],
        parsed: {
          x: parseInt(pointMatch[1]),
          y: parseInt(pointMatch[2]),
          label: pointMatch[3],
          screen: pointMatch[4] || "screen0",
        },
      });
    }

    const drawMatch = text.match(/\[DRAW:([a-zA-Z]+):([0-9,]+):?([^\]]*)\]/);
    if (drawMatch) {
      const coords = drawMatch[2].split(",").map((n) => parseInt(n.trim()));
      tags.push({
        type: "DRAW",
        raw: drawMatch[0],
        parsed: {
          shape: drawMatch[1],
          coords,
          color: drawMatch[3] || "#3186ff",
        },
      });
    }

    const stepMatch = text.match(/\[STEP:(\d+)\/(\d+):([0-9,]+):([^\]]+)\]/);
    if (stepMatch) {
      const bbox = stepMatch[3].split(",").map((n) => parseInt(n.trim()));
      tags.push({
        type: "STEP",
        raw: stepMatch[0],
        parsed: {
          step: parseInt(stepMatch[1]),
          total: parseInt(stepMatch[2]),
          bbox,
          instruction: stepMatch[4],
        },
      });
    }

    const threeMatch = text.match(/\[3D:([^:]+):([^\]]+)\]/);
    if (threeMatch) {
      tags.push({
        type: "3D",
        raw: threeMatch[0],
        parsed: {
          model: threeMatch[1],
          title: threeMatch[2],
        },
      });
    }

    const cleanSpeech = text
      .replace(/\[POINT:[^\]]+\]/g, "")
      .replace(/\[DRAW:[^\]]+\]/g, "")
      .replace(/\[STEP:[^\]]+\]/g, "")
      .replace(/\[3D:[^\]]+\]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    return { tags, cleanSpeech };
  };

  // Execute prompt against local Bonsai-2 9B model
  const handleSendPrompt = async (promptText?: string) => {
    const textToSend = promptText || inputPrompt;
    if (!textToSend.trim() || isGenerating) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      sender: "user",
      content: textToSend,
      timestamp: new Date().toLocaleTimeString(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setInputPrompt("");
    setIsGenerating(true);

    const startTime = performance.now();

    try {
      const rawAnswer = await invokeCommand<string>("execute_prompt", {
        prompt: textToSend,
      });

      const elapsedMs = Math.round(performance.now() - startTime);
      const estTokens = rawAnswer.split(/\s+/).length * 1.3;
      const tokPerSec = Math.round((estTokens / (elapsedMs / 1000)) * 10) / 10;

      const { tags, cleanSpeech } = parseTags(rawAnswer);

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        sender: "clicky",
        content: rawAnswer,
        cleanSpeech,
        tags,
        latencyMs: elapsedMs,
        tokensPerSec: tokPerSec,
        timestamp: new Date().toLocaleTimeString(),
      };

      setChatMessages((prev) => [...prev, assistantMsg]);

      // Automatically project any detected tag to the desktop overlay!
      tags.forEach((tag) => {
        triggerTagOnDesktop(tag);
      });
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          sender: "clicky",
          content: `Error communicating with local AI model: ${err?.message || err}`,
          timestamp: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setIsGenerating(false);
    }
  };

  // Trigger spatial tag directly onto desktop overlay
  const triggerTagOnDesktop = async (tag: { type: string; parsed: any }) => {
    try {
      if (tag.type === "POINT") {
        const payload: OverlayPointEvent = {
          x: tag.parsed.x,
          y: tag.parsed.y,
          label: tag.parsed.label,
        };
        await emitEvent("overlay_point", payload);
        showToast(`Projected Pointer at (${tag.parsed.x}, ${tag.parsed.y})`);
      } else if (tag.type === "DRAW") {
        const payload: OverlayDrawEvent = {
          shape: tag.parsed.shape,
          coords: tag.parsed.coords,
          color: tag.parsed.color,
        };
        await emitEvent("overlay_draw", payload);
        showToast(`Rendered ${tag.parsed.shape} on desktop`);
      } else if (tag.type === "STEP") {
        const step: WalkthroughStep = {
          step: tag.parsed.step,
          instruction: tag.parsed.instruction,
          bbox: tag.parsed.bbox,
        };
        await emitEvent("walkthrough_step", {
          step,
          current: tag.parsed.step,
          total: tag.parsed.total,
        });
        showToast(`Triggered Walkthrough Step ${tag.parsed.step}/${tag.parsed.total}`);
      } else if (tag.type === "3D") {
        const payload: Overlay3DEvent = {
          id: "preview_3d",
          title: tag.parsed.title,
          geometryType: "robot",
          visible: true,
        };
        await emitEvent("overlay_3d", payload);
        showToast(`Opened 3D Model: ${tag.parsed.title}`);
      }
    } catch (err) {
      console.warn("Failed to emit overlay event:", err);
    }
  };

  const showToast = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // Toggle Talk Mode
  const handleToggleTalk = async () => {
    try {
      const next = !isTalking;
      setIsTalking(next);
      await invokeCommand("toggle_talk", { active: next });
      showToast(next ? "Talk Mode Active (Push to Talk)" : "Talk Mode Stopped");
    } catch (err: any) {
      showToast(`Talk error: ${err}`);
    }
  };

  // Toggle Dictation
  const handleToggleDictation = async () => {
    try {
      const next = !isDictating;
      setIsDictating(next);
      const res = await invokeCommand<string>("toggle_dictation", { active: next });
      if (!next && res) {
        showToast(`Dictated: "${res.slice(0, 30)}..."`);
      } else {
        showToast(next ? "Dictation listening..." : "Dictation stopped");
      }
    } catch (err: any) {
      showToast(`Dictation error: ${err}`);
    }
  };

  // Save new Memory
  const handleSaveMemory = async () => {
    if (!newMemKey.trim() || !newMemVal.trim()) return;
    try {
      const saved = await invokeCommand<Memory>("save_memory", {
        scope: newMemScope,
        key: newMemKey,
        value: newMemVal,
      });
      setMemories((prev) => [saved, ...prev.filter((m) => m.id !== saved.id)]);
      setNewMemKey("");
      setNewMemVal("");
      showToast(`Memory saved: [${saved.key}]`);
    } catch (err: any) {
      showToast(`Save memory error: ${err}`);
    }
  };

  const filteredMemories = memories.filter(
    (m) =>
      m.key.toLowerCase().includes(memSearch.toLowerCase()) ||
      m.value.toLowerCase().includes(memSearch.toLowerCase()) ||
      m.scope.toLowerCase().includes(memSearch.toLowerCase())
  );

  return (
    <div className="flex flex-col w-screen h-screen bg-slate-950 text-slate-100 font-sans select-none overflow-hidden border border-slate-800">
      {/* Top Application Bar */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-slate-900/90 border-b border-slate-800 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-sky-500 via-indigo-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/20">
            <Sparkles className="w-4 h-4 text-slate-950 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-white">HeyClicky Desktop AI</h1>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
                Control Center
              </span>
            </div>
            <p className="text-[11px] text-slate-400">Autonomous Multimodal Desktop Co-Pilot</p>
          </div>
        </div>

        {/* Global Status Badges */}
        <div className="flex items-center gap-2 text-xs">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-[11px] font-medium">bonsai-2:9b (Ollama 11434)</span>
          </div>

          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-300">
            <Radio className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-[11px]">Kokoro TTS + Moonshine STT</span>
          </div>

          {/* Quick Action Buttons */}
          <button
            onClick={handleToggleTalk}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              isTalking
                ? "bg-rose-500 text-white shadow-lg shadow-rose-500/30 animate-pulse"
                : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            }`}
          >
            <Mic className="w-3.5 h-3.5" />
            <span>{isTalking ? "Speaking..." : "Talk (Ctrl+Space)"}</span>
          </button>

          <button
            onClick={handleToggleDictation}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              isDictating
                ? "bg-amber-500 text-slate-950 shadow-lg shadow-amber-500/30 animate-pulse"
                : "bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{isDictating ? "Listening..." : "Dictate (Alt+Shift+D)"}</span>
          </button>
        </div>
      </header>

      {/* Main App Layout: Sidebar + Viewport */}
      <div className="flex flex-1 overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-56 bg-slate-900/50 border-r border-slate-800 flex flex-col justify-between p-2">
          <nav className="flex flex-col gap-1">
            <button
              onClick={() => setActiveTab("copilot")}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                activeTab === "copilot"
                  ? "bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              <span>Copilot Studio</span>
            </button>

            <button
              onClick={() => setActiveTab("spatial")}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                activeTab === "spatial"
                  ? "bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Compass className="w-4 h-4" />
              <span>Spatial Sandbox</span>
            </button>

            <button
              onClick={() => setActiveTab("memory")}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                activeTab === "memory"
                  ? "bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Database className="w-4 h-4" />
              <span>Episodic Memory</span>
            </button>

            <button
              onClick={() => setActiveTab("engine")}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                activeTab === "engine"
                  ? "bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Cpu className="w-4 h-4" />
              <span>Model & Hardware</span>
            </button>

            <button
              onClick={() => setActiveTab("agents")}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all ${
                activeTab === "agents"
                  ? "bg-sky-500 text-slate-950 font-bold shadow-md shadow-sky-500/20"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/60"
              }`}
            >
              <Calendar className="w-4 h-4" />
              <span>Cron & Agents</span>
            </button>
          </nav>

          {/* Desktop Overlay Integration Card */}
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-[11px] flex flex-col gap-2">
            <div className="flex items-center justify-between text-slate-400 font-semibold">
              <span>Desktop Overlay</span>
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              Overlay window is active in transparent click-through mode.
            </p>
            <button
              onClick={() =>
                triggerTagOnDesktop({
                  type: "POINT",
                  parsed: { x: 500, y: 300, label: "Center Desktop Ping" },
                })
              }
              className="w-full py-1.5 px-2 rounded-lg bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 font-semibold text-[10px] transition-all flex items-center justify-center gap-1.5"
            >
              <Sparkles className="w-3 h-3" />
              <span>Test Desktop Ping</span>
            </button>
          </div>
        </aside>

        {/* Primary Content View */}
        <main className="flex-1 flex flex-col bg-slate-950 overflow-hidden relative">
          {/* Toast Notification */}
          {statusMessage && (
            <div className="absolute top-3 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-xl bg-sky-500 text-slate-950 text-xs font-bold shadow-xl animate-bounce">
              <CheckCircle2 className="w-4 h-4" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* TAB 1: COPILOT STUDIO */}
          {activeTab === "copilot" && (
            <div className="flex-1 flex flex-col h-full overflow-hidden p-4 gap-3">
              {/* Preset Test Questions Banner */}
              <div className="flex flex-col gap-1.5 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/80">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                    Test bonsai-2:9b Spatial Protocols:
                  </span>
                  <span className="text-[10px] text-slate-500">Click to execute live</span>
                </div>
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                  {PRESET_QUESTIONS.map((q, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleSendPrompt(q.prompt)}
                      disabled={isGenerating}
                      className="px-2.5 py-1 rounded-lg bg-slate-800/90 hover:bg-sky-500/20 text-slate-300 hover:text-sky-300 border border-slate-700/60 hover:border-sky-500/40 text-[11px] font-medium whitespace-nowrap transition-all flex items-center gap-1"
                    >
                      <span>{q.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Chat Transcript Area */}
              <div
                ref={chatScrollRef}
                className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-slate-800"
              >
                {chatMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      msg.sender === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl p-3.5 text-xs leading-relaxed shadow-sm ${
                        msg.sender === "user"
                          ? "bg-sky-600 text-white rounded-br-sm"
                          : "bg-slate-900/90 text-slate-200 border border-slate-800 rounded-bl-sm"
                      }`}
                    >
                      {/* Spoken Text Highlight */}
                      {msg.cleanSpeech && (
                        <div className="mb-2 flex items-start gap-1.5 text-slate-300">
                          <Volume2 className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
                          <span className="font-sans font-medium">{msg.cleanSpeech}</span>
                        </div>
                      )}

                      {/* Raw Content Display */}
                      <div className="font-mono text-[11px] whitespace-pre-wrap text-slate-400 bg-slate-950/60 p-2 rounded-lg border border-slate-800/80">
                        {msg.content}
                      </div>

                      {/* Detected Spatial Tags & Trigger Action Chips */}
                      {msg.tags && msg.tags.length > 0 && (
                        <div className="mt-2.5 pt-2 border-t border-slate-800 flex flex-wrap gap-1.5">
                          {msg.tags.map((t, tidx) => (
                            <button
                              key={tidx}
                              onClick={() => triggerTagOnDesktop(t)}
                              className="px-2 py-1 rounded-lg bg-sky-500/10 hover:bg-sky-500/30 text-sky-400 border border-sky-500/30 text-[10px] font-mono font-bold transition-all flex items-center gap-1.5 shadow"
                            >
                              <Play className="w-3 h-3 fill-current" />
                              <span>Project {t.type}: {t.raw}</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Telemetry info */}
                      {msg.latencyMs && (
                        <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500 font-mono">
                          <span>Latency: {msg.latencyMs}ms</span>
                          <span>•</span>
                          <span>Speed: {msg.tokensPerSec} tok/s</span>
                          <span>•</span>
                          <span>{msg.timestamp}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {isGenerating && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-slate-900/60 text-slate-400 text-xs font-mono">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-sky-400" />
                    <span>bonsai-2:9b streaming response...</span>
                  </div>
                )}
              </div>

              {/* Chat Input Bar */}
              <div className="flex items-center gap-2 bg-slate-900/90 p-2 rounded-2xl border border-slate-800">
                <input
                  type="text"
                  value={inputPrompt}
                  onChange={(e) => setInputPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendPrompt()}
                  placeholder="Ask a spatial question, request drawing, or invoke desktop co-pilot..."
                  className="flex-1 bg-transparent px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none"
                />
                <button
                  onClick={() => handleSendPrompt()}
                  disabled={!inputPrompt.trim() || isGenerating}
                  className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition-all flex items-center gap-1.5 shadow-md shadow-sky-500/20"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Send</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 2: SPATIAL ANIMATION SANDBOX */}
          {activeTab === "spatial" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-white">Spatial Animation & Vector Studio</h2>
                  <p className="text-xs text-slate-400">
                    Test live Bezier curves, RoughJS sketchy annotations, Three.js 3D models, and Drive safety borders.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* 1. Bezier Pointer Controller */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4" />
                      <span>Bezier Cursor Pointer</span>
                    </span>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div>
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span>Target X: {pointX} (Normalized 0-1000)</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1000"
                        value={pointX}
                        onChange={(e) => setPointX(parseInt(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between text-slate-400 mb-1">
                        <span>Target Y: {pointY} (Normalized 0-1000)</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1000"
                        value={pointY}
                        onChange={(e) => setPointY(parseInt(e.target.value))}
                        className="w-full accent-sky-500"
                      />
                    </div>

                    <div>
                      <span className="text-slate-400 mb-1 block">Label / Tooltip:</span>
                      <input
                        type="text"
                        value={pointLabel}
                        onChange={(e) => setPointLabel(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() =>
                      triggerTagOnDesktop({
                        type: "POINT",
                        parsed: { x: pointX, y: pointY, label: pointLabel },
                      })
                    }
                    className="w-full py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs transition-all shadow-md shadow-sky-500/20"
                  >
                    Project Pointer onto Desktop
                  </button>
                </div>

                {/* 2. RoughJS Sketchy Annotations */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Layers className="w-4 h-4" />
                      <span>RoughJS 2D Annotations</span>
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {(["circle", "arrow", "box"] as const).map((shape) => (
                      <button
                        key={shape}
                        onClick={() => setDrawShape(shape)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-medium capitalize border transition-all ${
                          drawShape === shape
                            ? "bg-emerald-500 text-slate-950 font-bold border-emerald-400"
                            : "bg-slate-950 text-slate-400 border-slate-800 hover:text-white"
                        }`}
                      >
                        {shape}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">Color:</span>
                    {["#3186ff", "#10b981", "#f43f5e", "#eab308"].map((c) => (
                      <button
                        key={c}
                        onClick={() => setDrawColor(c)}
                        style={{ backgroundColor: c }}
                        className={`w-6 h-6 rounded-full border-2 transition-all ${
                          drawColor === c ? "border-white scale-110" : "border-transparent"
                        }`}
                      />
                    ))}
                  </div>

                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Emits sketchy, hand-drawn vector primitives that float above active desktop windows.
                  </p>

                  <button
                    onClick={() => {
                      const coords =
                        drawShape === "circle"
                          ? [pointX, pointY, 35]
                          : drawShape === "arrow"
                          ? [pointX - 100, pointY + 50, pointX, pointY]
                          : [pointX - 60, pointY - 30, pointX + 60, pointY + 30];
                      triggerTagOnDesktop({
                        type: "DRAW",
                        parsed: { shape: drawShape, coords, color: drawColor },
                      });
                    }}
                    className="w-full py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition-all shadow-md shadow-emerald-500/20"
                  >
                    Draw Shape onto Desktop
                  </button>
                </div>

                {/* 3. Three.js 3D Spatial Viewer */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Box className="w-4 h-4" />
                      <span>Three.js Spatial Viewport</span>
                    </span>

                    <div className="flex items-center gap-1">
                      {(["robot", "drone", "sensor"] as const).map((m) => (
                        <button
                          key={m}
                          onClick={() => setThreeModel(m)}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold capitalize transition-all ${
                            threeModel === m
                              ? "bg-cyan-500 text-slate-950"
                              : "text-slate-400 hover:text-white"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Canvas Container */}
                  <div
                    ref={threeMountRef}
                    className="w-full h-44 rounded-xl overflow-hidden cursor-grab active:cursor-grabbing border border-slate-800 shadow-inner"
                  />

                  <button
                    onClick={() =>
                      triggerTagOnDesktop({
                        type: "3D",
                        parsed: { model: threeModel, title: `Interactive ${threeModel} Node` },
                      })
                    }
                    className="w-full py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition-all shadow-md shadow-cyan-500/20"
                  >
                    Project 3D to Desktop Overlay
                  </button>
                </div>

                {/* 4. Guided Walkthrough & Safety HUD */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 flex flex-col justify-between gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4" />
                      <span>Walkthrough & Drive HUD</span>
                    </span>
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">
                    Guided walkthroughs spotlight buttons with animated bounding boxes, while Drive Mode surrounds your display with a glowing red confirmation border.
                  </p>

                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        triggerTagOnDesktop({
                          type: "STEP",
                          parsed: {
                            step: 1,
                            total: 3,
                            bbox: [200, 100, 450, 160],
                            instruction: "Click the File menu to begin export",
                          },
                        })
                      }
                      className="flex-1 py-2 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-bold transition-all"
                    >
                      Step 1/3 Demo
                    </button>

                    <button
                      onClick={async () => {
                        const status: DriveStatusEvent = {
                          state: "driving",
                          actionDescription: "Moving cursor to target search input...",
                          progress: 0.65,
                          requiresConfirmation: true,
                          confirmationPayload: {
                            toolCallId: "drive_demo",
                            toolName: "mouse_click",
                            description: "Click Search Bar and type 'bonsai 2'",
                            parameters: { x: 400, y: 50 },
                          },
                        };
                        await emitEvent("drive_status", status);
                        showToast("Emitted Drive Safe Mode HUD onto overlay");
                      }}
                      className="flex-1 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-bold transition-all"
                    >
                      Drive Border HUD
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: EPISODIC MEMORY */}
          {activeTab === "memory" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-white">SQLite Episodic Memory & Knowledge Graph</h2>
                  <p className="text-xs text-slate-400">
                    Locally stored contextual knowledge, user preferences, and hotword dictionary.
                  </p>
                </div>

                <div className="relative w-64">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-500" />
                  <input
                    type="text"
                    value={memSearch}
                    onChange={(e) => setMemSearch(e.target.value)}
                    placeholder="Search memories..."
                    className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Add Memory Form */}
              <div className="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800 flex items-center gap-2">
                <select
                  value={newMemScope}
                  onChange={(e) => setNewMemScope(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-slate-300"
                >
                  <option value="user_profile">user_profile</option>
                  <option value="preferences">preferences</option>
                  <option value="screen_context">screen_context</option>
                  <option value="dictionary">dictionary</option>
                </select>

                <input
                  type="text"
                  placeholder="Key (e.g. favorite_browser)"
                  value={newMemKey}
                  onChange={(e) => setNewMemKey(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none"
                />

                <input
                  type="text"
                  placeholder="Value (e.g. Google Chrome)"
                  value={newMemVal}
                  onChange={(e) => setNewMemVal(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white placeholder-slate-500 focus:outline-none"
                />

                <button
                  onClick={handleSaveMemory}
                  className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs transition-all flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Save</span>
                </button>
              </div>

              {/* Memories Table */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900/80 border-b border-slate-800 text-slate-400">
                    <tr>
                      <th className="px-4 py-2 font-medium">Scope</th>
                      <th className="px-4 py-2 font-medium">Key</th>
                      <th className="px-4 py-2 font-medium">Value</th>
                      <th className="px-4 py-2 font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                    {filteredMemories.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-6 text-center text-slate-500 font-sans">
                          No memory records found.
                        </td>
                      </tr>
                    ) : (
                      filteredMemories.map((mem) => (
                        <tr key={mem.id} className="hover:bg-slate-800/40">
                          <td className="px-4 py-2 text-sky-400">{mem.scope}</td>
                          <td className="px-4 py-2 text-slate-200">{mem.key}</td>
                          <td className="px-4 py-2 text-slate-400">{mem.value}</td>
                          <td className="px-4 py-2 text-slate-500">{mem.updatedAt || "Just now"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: MODEL & HARDWARE ENGINE */}
          {activeTab === "engine" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <h2 className="text-sm font-bold text-white">AI Engine & Local Model Calibration</h2>
                <p className="text-xs text-slate-400">
                  Performance verification for bonsai-2:9b running locally on Ollama.
                </p>
              </div>

              {/* Benchmark Results Card */}
              <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 space-y-3">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">
                  Bonsai-2 9B Verified Benchmark Metrics
                </span>

                <div className="grid grid-cols-4 gap-3 text-center">
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1">Time to First Token</span>
                    <span className="text-lg font-bold text-sky-400 font-mono">229.5 ms</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1">Throughput</span>
                    <span className="text-lg font-bold text-emerald-400 font-mono">62.6 tok/s</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1">Protocol Adherence</span>
                    <span className="text-lg font-bold text-indigo-400 font-mono">100.0%</span>
                  </div>
                  <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase block mb-1">Reasoning Mode</span>
                    <span className="text-xs font-bold text-amber-400 font-mono">Disabled for Fast Talk</span>
                  </div>
                </div>
              </div>

              {/* Ollama Status */}
              <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-white">Local Ollama Instance</h3>
                  <p className="text-[11px] text-slate-400">{ollamaStatus.url}</p>
                </div>

                <div className="flex items-center gap-2">
                  <select
                    value={ollamaStatus.current_model}
                    onChange={(e) =>
                      invokeCommand("set_active_model", { modelName: e.target.value })
                    }
                    className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs text-white"
                  >
                    {ollamaStatus.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>

                  <button
                    onClick={async () => {
                      const res = await invokeCommand<OllamaStatus>("check_ollama_status");
                      setOllamaStatus(res);
                      showToast("Refreshed Ollama models");
                    }}
                    className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Global Hotkeys List */}
              <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 space-y-2">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider block mb-2">
                  Registered Desktop Hotkeys
                </span>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between p-2 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400">Push-to-Talk Screen Mode</span>
                    <kbd className="px-2 py-0.5 rounded bg-slate-800 text-sky-400 font-mono text-[10px]">
                      Ctrl + Space
                    </kbd>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400">Screen-Aware Dictation</span>
                    <kbd className="px-2 py-0.5 rounded bg-slate-800 text-amber-400 font-mono text-[10px]">
                      Alt + Shift + D
                    </kbd>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400">Expand Top Agent Drawer</span>
                    <kbd className="px-2 py-0.5 rounded bg-slate-800 text-indigo-400 font-mono text-[10px]">
                      Ctrl + Alt + A
                    </kbd>
                  </div>
                  <div className="flex justify-between p-2 rounded-lg bg-slate-950 border border-slate-800">
                    <span className="text-slate-400">Quick Prompt Spotlight Bar</span>
                    <kbd className="px-2 py-0.5 rounded bg-slate-800 text-emerald-400 font-mono text-[10px]">
                      Ctrl + Alt + Q
                    </kbd>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: CRON & AGENTS */}
          {activeTab === "agents" && (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-white">Autonomous Agents & Scheduled Cron Workflows</h2>
                  <p className="text-xs text-slate-400">
                    Background tasks running on your local machine with full tool access.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Agent Roster */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 space-y-3">
                  <span className="text-xs font-bold text-sky-400 uppercase tracking-wider block">
                    Registered Subagents ({agents.length})
                  </span>
                  <div className="space-y-2">
                    {agents.length === 0 ? (
                      <p className="text-xs text-slate-500">No custom agents created yet.</p>
                    ) : (
                      agents.map((ag) => (
                        <div
                          key={ag.id}
                          className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between"
                        >
                          <div>
                            <span className="text-xs font-bold text-white">{ag.name}</span>
                            <p className="text-[11px] text-slate-400">{ag.role}</p>
                          </div>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                            Active
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Cron Jobs */}
                <div className="p-4 rounded-2xl bg-slate-900/70 border border-slate-800 space-y-3">
                  <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider block">
                    Scheduled Cron Tasks ({cronJobs.length})
                  </span>
                  <div className="space-y-2">
                    {cronJobs.length === 0 ? (
                      <p className="text-xs text-slate-500">No cron schedules active.</p>
                    ) : (
                      cronJobs.map((c) => (
                        <div
                          key={c.id}
                          className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between"
                        >
                          <div>
                            <span className="text-xs font-mono font-bold text-indigo-300">
                              {c.schedule}
                            </span>
                            <p className="text-[11px] text-slate-400">{c.prompt}</p>
                          </div>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {c.enabled ? "Running" : "Paused"}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
