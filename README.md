# FlatPDF

Flatten PDFs and Word documents in the browser: every page is rendered to an
image and the images are packed into a new PDF with the same page sizes. Text,
vectors, layers, form fields and annotations become pixels.

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

## Word documents

A `.docx` file goes through the same steps, including the image editor, and
comes out as a flattened PDF. Only step 1 differs:
[docx-preview](https://github.com/VolodymyrBaydalka/docxjs) lays the document
out as HTML in a hidden frame, and the browser paints each page of that into
the canvas. The Word reader is downloaded the first time a Word file is added.

This is the browser's layout of the document, not Word's, so it is close but
not identical:

- pages start where Word last started them, when the file records that (files
  saved by Word do). A page that comes out up to a tenth too tall for its
  paper is scaled down to fit, so the page count stays the same;
- a file that does not record its pages (written by other software) is cut
  into pages between lines of text, with the header and footer repeated;
- fonts come from the device unless the document embeds them, so a font that
  is missing is replaced and lines may break differently;
- page numbers and other fields, text boxes, charts and SmartArt may be
  missing or simplified. When the exact look matters, save the document as a
  PDF in Word and flatten that.

The old `.doc` format and password-protected documents are not supported.

## Adding signatures and stamps

Every file in the list has an **Add images** button. It opens an editor that
shows the pages and lets you place images on them before the document is
flattened:

- add images with the button, by dropping them, or by pasting;
- drag to move, pull a corner to resize (the proportions are kept), use the
  arrow keys for fine moves and Delete to remove;
- an image you added stays in the editor's tray for the other pages and files,
  and **Copy to all pages** repeats a placement through the document.

The editor works at print scale: one image pixel is 1/300 inch, so a 600 px
wide signature is 50.8 mm wide on paper. When a PNG or JPEG file declares a
different resolution (72 or 96 dpi are common), the editor offers both sizes:
pixel for pixel at 300 dpi, or the physical size the file asks for.

Placed images are drawn into the page before it is flattened, so they come out
at the chosen output resolution and cannot be lifted out of the PDF as separate
images.

## Editing an NBS IPS QR code

The round QR button in the bottom right corner opens a second tool. It reads
the payment QR code Serbian bills carry (NBS IPS QR), shows what it says as a
payment slip (налог за уплату) and makes a new code from the edited slip. The
tool and its libraries are downloaded the first time the button is pressed.

- drop or paste a picture of the code into the popup, or click it to choose a
  picture or a PDF bill (a PDF is searched page by page at 300 dpi);
- edit payer, purpose, payee, payment code, amount, account, model and
  reference; any other fields the code has are listed under the slip;
- the amount is checked as you type and, once you leave the field, written
  out in full the way it goes on a paper slip (1250 becomes 1.250,00);
- the new code is drawn as you type, with the **same QR version, error
  correction level and pixels per module** as the original, so it is the same
  size and density. If the new data no longer fits that version, the smallest
  version that holds it is used and the slip says so;
- **Fill in a blank slip** in the same popup opens an empty slip instead: fill it in and the
  code is made from scratch, in the smallest version that holds the data, at
  error correction level M, 6 pixels per module (adjustable);
- **Download PNG**, **Copy image**, or **Add to image tray** to place the new
  code on a PDF with the image editor above. A code read from a PDF comes out
  at the same physical size when placed at 300 dpi.

Fields that were not edited are written back character for character. The
slip warns about values the specification does not allow (lengths, an account
or model 97 reference whose control digits do not match, a code above version
13) but still makes the code. Reading uses
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm), served from this site,
and writing uses [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator).

## Settings

- **Resolution**: Screen 72 dpi, Small 96 dpi, Balanced 150 dpi (default), Sharp 200 dpi,
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
