import { getPool } from "../db.js";

export interface SharedDocument {
  id: string;
  parentId: string;
  parentName: string;
  documentName: string;
  documentType: string;
  mimeType: string;
  uploadedAt: string;
  // 'confirmed' once the parent has reviewed it; anything else is an unreviewed AI draft.
  status: string;
  reviewedAt: string | null;
  extractedData: unknown;
}

export async function listSharedDocuments(parentIds: string[]): Promise<SharedDocument[]> {
  if (parentIds.length === 0) {
    return [];
  }

  const pool = getPool();
  const result = await pool.query<{
    id: string;
    parent_id: string;
    document_name: string;
    document_type: string;
    mime_type: string;
    created_at: Date;
    status: string;
    reviewed_at: Date | null;
    extracted_data: unknown;
    parent_name: string;
  }>(
    // Once a document is confirmed, the user-reviewed values are what a caregiver
    // should see — not the original, possibly-corrected AI draft.
    `SELECT d.id, d.parent_id, d.document_name, d.document_type, d.mime_type, d.created_at, d.status, d.reviewed_at,
            COALESCE(d.reviewed_data, d.extracted_data) AS extracted_data, p.full_name AS parent_name
     FROM documents d
     JOIN parents p ON p.id = d.parent_id
     WHERE d.parent_id = ANY($1::text[])
     ORDER BY d.created_at DESC`,
    [parentIds]
  );

  return result.rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    parentName: row.parent_name,
    documentName: row.document_name,
    documentType: row.document_type,
    mimeType: row.mime_type,
    uploadedAt: row.created_at.toISOString(),
    status: row.status,
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
    extractedData: row.extracted_data,
  }));
}
