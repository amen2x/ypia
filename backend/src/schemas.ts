import { z } from "zod";

export const medicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().min(1).nullable(),
  frequency: z.string().min(1).nullable(),
  status: z.enum(["active", "started", "stopped", "changed", "unknown"])
});

export const appointmentSchema = z.object({
  type: z.string().min(1).nullable(),
  provider: z.string().min(1).nullable(),
  date: z.string().min(1).nullable(),
  time: z.string().min(1).nullable(),
  location: z.string().min(1).nullable()
});

export const followUpSchema = z.object({
  description: z.string().min(1),
  timeframe: z.string().min(1).nullable()
});

export const extractedDocumentSchema = z.object({
  documentType: z.enum([
    "prescription",
    "after_visit_summary",
    "discharge_summary",
    "appointment",
    "lab",
    "other"
  ]),
  medications: z.array(medicationSchema),
  appointments: z.array(appointmentSchema),
  followUps: z.array(followUpSchema),
  instructions: z.array(z.string().min(1))
});
