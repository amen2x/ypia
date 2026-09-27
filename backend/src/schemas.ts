import { z } from "zod";

export const medicationSchema = z.object({
  name: z.string().min(1),
  dose: z.string().min(1).nullable(),
  frequency: z.string().min(1).nullable(),
  status: z.enum(["active", "started", "stopped", "changed", "unknown"])
});

export const backgroundNotesSchema = z.object({
  backgroundNotes: z.string()
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
  // Must match the documents_document_type_check constraint in the database exactly.
  documentType: z.enum(["prescription", "after_visit_summary", "appointment_letter", "lab_result", "other"]),
  medications: z.array(medicationSchema),
  appointments: z.array(appointmentSchema),
  followUps: z.array(followUpSchema),
  instructions: z.array(z.string().min(1))
});

export const signupSchema = z
  .object({
    role: z.enum(["parent", "child"]),
    fullName: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
    parentEmail: z.string().email().optional(),
    relationship: z.string().min(1).optional()
  })
  .refine((data) => data.role !== "child" || !!data.parentEmail, {
    message: "parentEmail is required when role is child",
    path: ["parentEmail"]
  });

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});
