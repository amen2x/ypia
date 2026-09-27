import { getPool } from "../db.js";

export interface SharedDocument {
  id: string;
  parentName: string;
  documentName: string;
  documentType: string;
  mimeType: string;
  uploadedAt: string;
  extractedData: unknown;
}

export async function listSharedDocuments(parentIds: string[]): Promise<SharedDocument[]> {
  if (parentIds.length === 0) {
    return [];
  }

  const pool = getPool();
  const result = await pool.query<{
    id: string;
    document_name: string;
    document_type: string;
    mime_type: string;
    created_at: Date;
    extracted_data: unknown;
    parent_name: string;
  }>(
    // Once a document is confirmed, the user-reviewed values are what a caregiver
    // should see — not the original, possibly-corrected AI draft.
    `SELECT d.id, d.document_name, d.document_type, d.mime_type, d.created_at,
            COALESCE(d.reviewed_data, d.extracted_data) AS extracted_data, p.full_name AS parent_name
     FROM documents d
     JOIN parents p ON p.id = d.parent_id
     WHERE d.parent_id = ANY($1::text[])
     ORDER BY d.created_at DESC`,
    [parentIds]
  );

  return result.rows.map((row) => ({
    id: row.id,
    parentName: row.parent_name,
    documentName: row.document_name,
    documentType: row.document_type,
    mimeType: row.mime_type,
    uploadedAt: row.created_at.toISOString(),
    extractedData: row.extracted_data,
  }));
}
