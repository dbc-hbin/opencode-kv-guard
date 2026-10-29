import { createHash } from "node:crypto"
import type { WireMessage } from "./prefix"

export const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
export const isSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export const instruction = (message: WireMessage) => message.role === "system" || message.role === "developer"
export const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
