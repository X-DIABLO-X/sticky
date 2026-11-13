import React, { useRef, useState, useEffect } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import type { Overlay3DEvent, PartPin } from "../../types/events";
import { setIgnoreCursorEvents } from "../../lib/ipc";
import { Box, RotateCcw, X, Info, Maximize2, Minimize2 } from "lucide-react";

interface Model3DViewerProps {
  model?: Overlay3DEvent | null;
  onClose?: () => void;
}

// Interactive 3D Robot Arm / Cyber Device Model
function RoboticGadgetModel({ isRotating }: { isRotating: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const coreRingRef = useRef<THREE.Mesh>(null);
  const satelliteRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    if (isRotating && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.6;
    }
    if (coreRingRef.current) {
      coreRingRef.current.rotation.x += delta * 1.2;
      coreRingRef.current.rotation.z += delta * 0.8;
    }
    if (satelliteRef.current) {
      satelliteRef.current.rotation.y -= delta * 1.5;
    }
  });

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      {/* Base Platform */}
      <mesh position={[0, -1.2, 0]}>
        <cylinderGeometry args={[1.4, 1.6, 0.3, 32]} />
        <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.2} />
      </mesh>

      {/* Main Articulated Arm / Body */}
      <mesh position={[0, -0.4, 0]}>
        <cylinderGeometry args={[0.6, 0.8, 1.3, 24]} />
        <meshStandardMaterial color="#0284c7" metalness={0.9} roughness={0.15} />
      </mesh>

      {/* Gyroscopic Core Ring */}
      <mesh ref={coreRingRef} position={[0, 0.4, 0]}>
        <torusGeometry args={[0.9, 0.12, 16, 48]} />
        <meshStandardMaterial color="#38bdf8" emissive="#0284c7" emissiveIntensity={0.6} />
      </mesh>

      {/* Central Floating Sphere */}
      <mesh position={[0, 0.4, 0]}>
        <sphereGeometry args={[0.45, 32, 32]} />
        <meshStandardMaterial color="#38bdf8" roughness={0.1} metalness={0.9} />
      </mesh>

      {/* Scanner Head / Optical Sensor */}
      <mesh position={[0, 1.2, 0]}>
        <coneGeometry args={[0.5, 0.8, 16]} />
        <meshStandardMaterial color="#6366f1" emissive="#4f46e5" emissiveIntensity={0.4} />
      </mesh>

      {/* Orbiting Satellite Sensor */}
      <mesh ref={satelliteRef} position={[1.4, 0.8, 0]}>
        <octahedronGeometry args={[0.22]} />
        <meshStandardMaterial color="#a855f7" emissive="#9333ea" emissiveIntensity={0.8} />
      </mesh>
    </group>
  );
}

export const Model3DViewer: React.FC<Model3DViewerProps> = ({ model, onClose }) => {
  const [position, setPosition] = useState({ x: window.innerWidth - 400, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isRotating, setIsRotating] = useState(true);
  const [selectedPin, setSelectedPin] = useState<PartPin | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);

  // Default Pins if none provided
  const pins: PartPin[] = model?.partPins || [
    {
      id: "pin-sensor",
      name: "LiDAR Scanner Optic",
      description: "Omnidirectional time-of-flight depth scanner at 60 Hz.",
      position: [0, 1.2, 0],
    },
    {
      id: "pin-core",
      name: "Quantum Logic Processor",
      description: "Low-latency sub-10ms neural routing node.",
      position: [0, 0.4, 0],
    },
    {
      id: "pin-base",
      name: "Magnetic Mount Base",
      description: "High-torque dual-axis brushless actuator base.",
      position: [0, -1.2, 0],
    },
  ];

  if (!model || model.visible === false) return null;

  // Window drag handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragOffset({
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: Math.max(10, Math.min(window.innerWidth - 380, e.clientX - dragOffset.x)),
      y: Math.max(10, Math.min(window.innerHeight - 380, e.clientY - dragOffset.y)),
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, dragOffset]);

  return (
    <div
      className="fixed z-40 select-none pointer-events-auto"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
      onMouseEnter={() => setIgnoreCursorEvents(false)}
      onMouseLeave={() => setIgnoreCursorEvents(true)}
    >
      <div className="w-[360px] rounded-2xl glass-panel border border-sky-400/40 shadow-2xl overflow-hidden flex flex-col">
        {/* Header Drag Bar */}
        <div
          onMouseDown={handleMouseDown}
          className="flex items-center justify-between px-3.5 py-2.5 bg-slate-900/80 border-b border-white/10 cursor-move"
        >
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-semibold text-slate-100">
              {model.title || "3D Spatial Object"}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsRotating(!isRotating)}
              className={`p-1 rounded hover:bg-white/10 transition-colors ${
                isRotating ? "text-sky-400" : "text-slate-400"
              }`}
              title="Toggle Auto-Rotation"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
            >
              {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 3D Viewport */}
        {!isMinimized && (
          <div className="relative w-[360px] h-[300px] bg-slate-950/70">
            <Canvas camera={{ position: [0, 1.2, 4], fov: 45 }}>
              <ambientLight intensity={0.7} />
              <directionalLight position={[5, 10, 5]} intensity={1.5} color="#ffffff" />
              <pointLight position={[-5, -5, -5]} intensity={0.5} color="#38bdf8" />
              <RoboticGadgetModel isRotating={isRotating} />
            </Canvas>

            {/* Clickable Part Pin Buttons */}
            <div className="absolute bottom-2 left-2 right-2 flex flex-wrap gap-1.5">
              {pins.map((pin) => (
                <button
                  key={pin.id}
                  onClick={() => setSelectedPin(selectedPin?.id === pin.id ? null : pin)}
                  className={`px-2 py-0.5 rounded-full text-[11px] font-medium backdrop-blur-md transition-all ${
                    selectedPin?.id === pin.id
                      ? "bg-sky-500 text-white shadow-md shadow-sky-500/40"
                      : "bg-slate-800/80 hover:bg-slate-700/80 text-sky-300 border border-sky-400/30"
                  }`}
                >
                  {pin.name}
                </button>
              ))}
            </div>

            {/* Part Pin Callout Tooltip */}
            {selectedPin && (
              <div className="absolute top-3 left-3 right-3 p-2.5 rounded-xl bg-slate-900/90 border border-sky-400/50 shadow-xl backdrop-blur-md animate-float">
                <div className="flex items-center gap-1.5 text-xs font-bold text-sky-300 mb-0.5">
                  <Info className="w-3.5 h-3.5 text-sky-400" />
                  <span>{selectedPin.name}</span>
                </div>
                <p className="text-[11px] text-slate-300 leading-snug">
                  {selectedPin.description}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
