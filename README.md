# FlatPDF

Flatten PDFs in the browser: every page is rendered to an image and the images
are packed into a new PDF with the same page sizes. Text, vectors, layers, form
fields and annotations become pixels.

**https://pavle-goloskokovic.github.io/flatpdf/**

There is no backend. Files are read, rendered and rebuilt inside the tab and
never leave the device.

## How it works

1. [pdf.js](https://mozilla.github.io/pdf.js/) renders each page to a canvas at
   the chosen resolution.
2. The canvas is encoded as JPEG (optionally converted to grayscale first).
3. [pdf-lib](https://pdf-lib.js.org/) writes a new PDF with one image per page.

Several files can be dropped at once; they are processed one after another and
can be downloaded individually or together as a zip.

| Preset   | Resolution | JPEG quality |
|----------|------------|--------------|
| Small    | 100 dpi    | 0.60         |
| Balanced | 150 dpi    | 0.75         |
| Sharp    | 220 dpi    | 0.82         |
| Print    | 300 dpi    | 0.88         |

A flattened PDF is not always smaller than the original: a text-only document
usually grows, while a document full of large photos usually shrinks.

## Development

```sh
npm install
npm run dev      # local dev server
npm run build    # type check + production build into dist/
```

Pushing to `main` builds and deploys to GitHub Pages through
`.github/workflows/deploy.yml`.
