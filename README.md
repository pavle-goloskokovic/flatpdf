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
2. The canvas is optionally distorted against OCR and converted to grayscale,
   then encoded as JPEG.
3. [pdf-lib](https://pdf-lib.js.org/) writes a new PDF with one image per page.

Several files can be dropped at once; they are processed one after another and
can be downloaded individually or together as a zip.

## Settings

- **Resolution**: Screen 72 dpi (default), Small 100 dpi, Balanced 150 dpi, Sharp 220 dpi,
  Print 300 dpi.
- **Image quality**: JPEG quality from 10 to 100, default 60. JPEG is used
  because it is the compact image format PDF supports natively.
- **Grayscale**: drops colour.
- **Printable content only**: off by default. Leaves out every annotation the
  PDF does not mark as printable and includes print-only ones, like a printer
  would. Form command buttons (reset, links, screen-only) are always left out.
- **OCR protection**: Off (default), Light or Strong. The page is bent
  slightly and short strokes in the text colour are scattered over text areas,
  so characters touch and OCR cannot separate them cleanly.

OCR protection is a deterrent, not a guarantee. Measured on a page of 9 to
12 pt text at 150 dpi and quality 60 with Tesseract 5, counting correctly read words:

| Protection | Read as-is | Best result after clean-up filters |
|------------|------------|------------------------------------|
| Off        | 100%       | 100%                               |
| Light      | 6%         | 48%                                |
| Strong     | 2%         | 28%                                |

Newer OCR engines and vision models are more robust than Tesseract and will
recover more. Anything a person can read comfortably, good enough software can
eventually read too.

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
