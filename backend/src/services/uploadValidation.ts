import path from "node:path";

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export type UploadErrorCode =
  | "no_file"
  | "empty_file"
  | "unsupported_type"
  | "file_too_large"
  | "unreadable_file"
  | "ai_not_configured"
  | "ai_unavailable"
  | "ai_bad_output"
  | "save_failed";

const MESSAGES: Record<UploadErrorCode, { status: number; message: string }> = {
  no_file: { status: 400, message: "Please choose a document to upload." },
  empty_file: { status: 400, message: "That file is empty. Please choose a different one." },
  unsupported_type: { status: 415, message: "That file type isn't supported. Please upload a PDF, JPG or PNG." },
  file_too_large: { status: 413, message: "That file is too large. Please upload one under 15 MB." },
  unreadable_file: { status: 422, message: "We couldn't read that file. It may be damaged. Try another PDF or a clearer photo." },
  ai_not_configured: { status: 503, message: "Document reading isn't set up on our side right now. Please try again later." },
  ai_unavailable: { status: 503, message: "The document reader is busy or unavailable right now. Please try again in a few minutes." },
  ai_bad_output: { status: 502, message: "We couldn't make sense of this document. Try a clearer photo or another file." },
  save_failed: { status: 500, message: "We read the document but couldn't save it. Please try again." },
};

// A failure with a stable code and a message that is always safe to show a parent.
// Raw provider/database errors never travel in `message`.
export class DocumentUploadError extends Error {
  readonly code: UploadErrorCode;
  readonly httpStatus: number;

  constructor(code: UploadErrorCode) {
    super(MESSAGES[code].message);
    this.code = code;
    this.httpStatus = MESSAGES[code].status;
  }
}

const EXTENSION_KINDS: Record<string, "pdf" | "png" | "jpeg"> = {
  ".pdf": "pdf",
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
};

const MEDIA_TYPES = { pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg" } as const;

function detectKind(buffer: Buffer): "pdf" | "png" | "jpeg" | null {
  // %PDF- may follow a few bytes of junk in real-world files, but never far in.
  if (buffer.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  return null;
}

// Checks the declared name against the real bytes. Returns the true media type, which is
// what gets stored and sent for reading — never the client-declared one.
export function validateUpload(originalName: string, buffer: Buffer): { mediaType: string; extension: string } {
  if (buffer.length === 0) throw new DocumentUploadError("empty_file");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new DocumentUploadError("file_too_large");

  const extension = path.extname(originalName).toLowerCase();
  // Tests feed a pre-structured JSON "extraction" so they can exercise the upload route without
  // calling the AI. Off unless explicitly enabled; real uploads are PDF/JPG/PNG only.
  if (extension === ".json" && process.env.YPIA_TEST_ALLOW_JSON_UPLOAD === "1") {
    return { mediaType: "application/json", extension };
  }
  const declared = EXTENSION_KINDS[extension];
  if (!declared) throw new DocumentUploadError("unsupported_type");

  const actual = detectKind(buffer);
  // A supported name over unsupported/mismatched bytes (e.g. a .txt renamed .pdf) is not a real document.
  if (!actual || actual !== declared) throw new DocumentUploadError("unreadable_file");

  return { mediaType: MEDIA_TYPES[actual], extension };
}
