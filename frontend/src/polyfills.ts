import { Buffer } from "buffer";

const browserGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

browserGlobal.Buffer ??= Buffer;
