import { useEffect, useRef } from "react";
import type { Mesh } from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { RobotModel, type Expression, type Motion } from "../RobotModel";
import type { PetState } from "../../../../shared/pet";

function Ball({ near, moving, animate, reactionId }: { reactionId: number; near: boolean; moving: boolean; animate: boolean }) {
  const mesh = useRef<Mesh>(null);
  const elapsed = useRef(0);
  useEffect(() => { elapsed.current = 0; }, [moving, reactionId]);
  useFrame((_, delta) => {
    if (!mesh.current) return;
    elapsed.current += delta;
    const t = Math.min(1, elapsed.current / 1.4);
    const rolling = moving && animate ? Math.sin(t * Math.PI) : 0;
    mesh.current.position.x = (near ? 0.8 : 1.7) - rolling * 1.3;
    mesh.current.position.z = 0.75 + rolling * 0.3;
    mesh.current.rotation.z = rolling * 5;
  });
  return <mesh ref={mesh} position={[near ? 0.8 : 1.7, -0.87, 0.75]}><sphereGeometry args={[0.26, 24, 16]} /><meshStandardMaterial color="#0052ff" roughness={0.3} /></mesh>;
}
export default function RoomCanvas({ state, expression, motion, animate, look, reactionId }: { reactionId: number; state: PetState | null; expression: Expression; motion: Motion; animate: boolean; look: { x: number; y: number } }) {
  return <Canvas camera={{ position: [0, 1.5, 7.7], fov: 43 }} dpr={[1, 1.5]} frameloop={animate ? "always" : "demand"} gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: "low-power" }} aria-hidden="true">
    <color attach="background" args={["#f4f7ff"]} />
    <ambientLight intensity={0.7} /><directionalLight position={[3, 5, 5]} intensity={2} />
    <mesh position={[0, -1.16, 0]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[30, 30]} /><meshStandardMaterial color="#e7edfc" /></mesh>
    <mesh position={[0, -1.12, 0]} scale={[1.7, 1, 1]}><cylinderGeometry args={[1.25, 1.25, 0.06, 64]} /><meshStandardMaterial color="#bbcfff" /></mesh>
    <group position={[0, 0.14, 0]} scale={1.18}><RobotModel reactionId={reactionId} expression={expression} motion={motion} look={look} animate={animate} gear={[]} /></group>
    <group position={[-2, -0.93, 0]}><mesh><cylinderGeometry args={[0.48, 0.52, 0.28, 32]} /><meshStandardMaterial color="#fff" /></mesh><mesh position={[0, 0.15, 0]}><cylinderGeometry args={[0.37, 0.37, 0.03, 32]} /><meshStandardMaterial color="#0052ff" emissive="#0052ff" emissiveIntensity={motion === "eat" ? 1 : 0.15} /></mesh></group>
    <Ball reactionId={reactionId} near={state?.favorite === "ball" || motion === "spin"} moving={motion === "spin"} animate={animate} />
    <group position={[2.1, 0.3, -1]}><mesh><boxGeometry args={[1.25, 0.09, 0.6]} /><meshStandardMaterial color="#fff" /></mesh>{(state?.props ?? []).slice(0, 3).map((prop, i) => <mesh key={prop} position={[-0.4 + i * 0.4, 0.18, 0]} rotation={[0.1, 0.3, 0.2]}><octahedronGeometry args={[0.16]} /><meshStandardMaterial color={i % 2 ? "#0052ff" : "#f4c95d"} metalness={0.5} roughness={0.2} /></mesh>)}</group>
    <mesh position={[-1.6, -1.01, 1]} rotation={[0, -0.3, 0]}><boxGeometry args={[0.72, 0.12, 0.5]} /><meshStandardMaterial color="#14213d" /></mesh>
    {state && state.needs.cleanliness < 50 ? [0, 1, 2, 3].map(i => <mesh key={i} position={[-0.48 + i * 0.32, 0.68 + (i % 2) * 0.1, 0.93]}><sphereGeometry args={[0.045, 8, 8]} /><meshStandardMaterial color="#8492ab" /></mesh>) : null}
  </Canvas>;
}
