# Backend foundation

This standalone TypeScript module validates extracted healthcare document data, enriches medications with public RxNorm identifiers, and prints the result as JSON. All included samples contain synthetic patient data.

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

`documentExtractor` currently reads and validates sample JSON. Its stable `extractDocument(filePath)` interface will later allow Gemini-based image and PDF extraction to replace that implementation.

The RxNorm service calls the official public RxNorm REST API to look up medication names. If the service is unavailable, malformed, or cannot find a match, the pipeline still completes and returns `null` RxNorm fields for that medication.
