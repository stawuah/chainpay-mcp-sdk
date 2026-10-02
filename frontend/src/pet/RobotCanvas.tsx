import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { RobotModel, type Expression, type Motion } from "./RobotModel";

type Props = {
  expression: Expression;
  motion: Motion;
  look: { x: number; y: number };
  animate: boolean;
};

export default function RobotCanvas({ expression, motion, look, animate }: Props) {
  // Stop drawing while the tab is in the background.
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return (
    <Canvas
      className="cp-pet-canvas"
      dpr={[1, 1.5]}
      frameloop={!visible ? "never" : animate ? "always" : "demand"}
      camera={{ position: [0, 0.05, 4.4], fov: 32 }}
      gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
      aria-hidden="true"
    >
      <ambientLight intensity={0.35} />
      <directionalLight position={[2, 3, 4]} intensity={1.4} />
      <directionalLight position={[-3, 1, -2]} intensity={0.6} color="#9db8ff" />
      <RobotModel expression={expression} motion={motion} look={look} animate={animate} />
    </Canvas>
  );
}
