"use client";

import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useRef } from "react";

// The in-editor view for a resizable image (spec 0026 AC-5). When the image is selected it shows
// a floating toolbar (Small / Medium / Full + left/center/right) and a corner drag handle that
// sets an arbitrary width live. Size is stored as the `width` attribute, alignment as
// `data-align`; the reader renders the same plain attributes via .help-content CSS.

const PRESETS: { label: string; width: number | null }[] = [
  { label: "S", width: 320 },
  { label: "M", width: 560 },
  { label: "Full", width: null },
];
const ALIGNS: { label: string; value: string }[] = [
  { label: "Left", value: "left" },
  { label: "Center", value: "center" },
  { label: "Right", value: "right" },
];

export function ResizableImageView({
  node,
  updateAttributes,
  selected,
  editor,
}: NodeViewProps) {
  const src = node.attrs.src as string;
  const alt = (node.attrs.alt as string | null) ?? "";
  const width = node.attrs.width as number | null;
  const align = (node.attrs.dataAlign as string | null) ?? "center";
  const imgRef = useRef<HTMLImageElement>(null);
  const editable = editor.isEditable;
  const showTools = editable && selected;

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = imgRef.current?.offsetWidth ?? width ?? 0;
    function onMove(ev: MouseEvent) {
      const next = Math.max(80, Math.round(startW + (ev.clientX - startX)));
      updateAttributes({ width: next });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <NodeViewWrapper className="ri-wrap" data-align={align}>
      <span
        className="ri-frame"
        data-selected={selected ? "1" : undefined}
        style={width ? { width: `${width}px` } : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={src} alt={alt} draggable={false} className="ri-img" />

        {showTools && (
          <span className="ri-toolbar" contentEditable={false}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`ri-btn${(p.width ?? null) === (width ?? null) ? " ri-on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  updateAttributes({ width: p.width });
                }}
              >
                {p.label}
              </button>
            ))}
            <span className="ri-sep" aria-hidden />
            {ALIGNS.map((a) => (
              <button
                key={a.value}
                type="button"
                className={`ri-btn${align === a.value ? " ri-on" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  updateAttributes({ dataAlign: a.value });
                }}
              >
                {a.label}
              </button>
            ))}
          </span>
        )}

        {showTools && (
          <span
            className="ri-handle"
            aria-hidden
            onMouseDown={startDrag}
            title="Drag to resize"
          />
        )}
      </span>
    </NodeViewWrapper>
  );
}
