// Servico unico de exportacao usado pelos relatorios do painel.
// Substitui o antigo CSV: agora cada tela oferece download em PDF e DOCX.
// As bibliotecas sao carregadas sob demanda para nao pesar no bundle inicial.

export function buildFileName(prefix, extension) {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

export async function exportPdf({ title, subtitle = "", headers, rows, fileName }) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const generatedAt = formatGeneratedAt();

  doc.setFontSize(15);
  doc.text(String(title || "Relatorio"), 40, 40);

  doc.setFontSize(10);
  doc.setTextColor(90);
  const headerLines = [subtitle, `Gerado em ${generatedAt}`, `${rows.length} registro(s)`].filter(Boolean);
  doc.text(headerLines.join("  |  "), 40, 58);
  doc.setTextColor(0);

  autoTable(doc, {
    head: [headers],
    body: rows.map((row) => row.map(toCellText)),
    startY: 74,
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [244, 246, 251] },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      const pageSize = doc.internal.pageSize;
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        `Pagina ${doc.internal.getNumberOfPages()}`,
        pageSize.getWidth() - 40,
        pageSize.getHeight() - 20,
        { align: "right" }
      );
      doc.setTextColor(0);
    }
  });

  doc.save(fileName);
}

export async function exportDocx({ title, subtitle = "", headers, rows, fileName }) {
  const { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } =
    await import("docx");
  const generatedAt = formatGeneratedAt();

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map(
          (header) =>
            new TableCell({
              shading: { fill: "2563EB" },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: String(header), bold: true, color: "FFFFFF", size: 18 })]
                })
              ]
            })
        )
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: toCellText(cell), size: 18 })] })]
                })
            )
          })
      )
    ]
  });

  const docxFile = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: String(title || "Relatorio"), heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: [
              new TextRun({
                text: [subtitle, `Gerado em ${generatedAt}`, `${rows.length} registro(s)`].filter(Boolean).join("  |  "),
                italics: true,
                color: "5A5A5A",
                size: 18
              })
            ]
          }),
          new Paragraph({ text: "" }),
          table
        ]
      }
    ]
  });

  const blob = await Packer.toBlob(docxFile);
  downloadBlob(blob, fileName);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function toCellText(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function formatGeneratedAt() {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date());
}
