# Backend foundation

This standalone TypeScript module validates extracted healthcare document data, enriches medications with public RxNorm identifiers, and prints the result as JSON. It accepts local JSON samples plus JPG, JPEG, PNG, and PDF documents. All included samples contain synthetic patient data.

## Setup

From this directory:

```sh
npm install
npm run typecheck
npm run test-pipeline
```

Run a specific sample with:

```sh
npm run test-pipeline -- samples/sample-after-visit.json
```

For an image or PDF, set `GEMINI_API_KEY` in your local environment and run:

```sh
npm run test-pipeline -- samples/test-medication.jpg
npm run test-pipeline -- samples/test-document.pdf
```

`documentExtractor` preserves the existing JSON path by reading and validating it locally. For images and PDFs, it sends the file as inline media to Gemini `gemini-3.8-flash`, requests structured JSON, and validates the response with the same Zod schema. Gemini is instructed to extract only visible document information and never provide medical advice.

The RxNorm service calls the official public RxNorm REST API to look up medication names. If the service is unavailable, malformed, or cannot find a match, the pipeline still completes and returns `null` RxNorm fields for that medication.

## Upload API

Start the backend with:

```sh
npm run start
```

Upload a supported JSON, JPG, JPEG, PNG, or PDF file as multipart form field `document`:

```sh
curl -F "document=@samples/test-medication.png" http://localhost:3000/api/documents
```

The endpoint runs `extractDocument`, validates the extracted document, normalizes medications with RxNorm, and returns the normalized JSON. Uploads are written to a temporary directory only for processing, then removed.
