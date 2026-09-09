import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ResizableImageView } from "./resizable-image-view";

// A Tiptap image that carries a `width` (pixels) and a `data-align` (left/center/right), edited
// through the ResizableImageView node view (drag handle + Small/Medium/Full + align, spec 0026
// AC-5). Both render as plain attributes the js-xss sanitizer already allows (`width` is native;
// `data-align` is whitelisted in help-sanitize), so no inline style ever reaches stored HTML.

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = (el as HTMLElement).getAttribute("width");
          if (!w) return null;
          const n = Number.parseInt(w, 10);
          return Number.isFinite(n) ? n : null;
        },
        renderHTML: (attrs: { width?: number | null }) =>
          attrs.width ? { width: attrs.width } : {},
      },
      dataAlign: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute("data-align"),
        renderHTML: (attrs: { dataAlign?: string | null }) =>
          attrs.dataAlign ? { "data-align": attrs.dataAlign } : {},
      },
    };
  },
  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },
});
