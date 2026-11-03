#!/usr/bin/env python3
"""PDF de test synthétiques (aucune donnée réelle) pour le harnais natif."""

import sys
from pathlib import Path

WIRE_LINES = [
    ("F2", 20, 72, 760, "Wire Transfer Instructions"),
    ("F1", 11, 72, 736, "International wire transfer in EUR"),
    ("F2", 13, 150, 700, "Beneficiary"),
    ("F1", 12, 150, 682, "SASU EXEMPLE"),
    ("F2", 13, 150, 646, "Beneficiary Bank"),
    ("F1", 12, 150, 628, "Banque Test"),
    ("F1", 12, 150, 610, "AG TEST (00001)"),
    ("F1", 12, 150, 592, "1 rue Exemple"),
    ("F2", 13, 150, 556, "SWIFT / BIC Code"),
    ("F1", 12, 150, 538, "TESTFRPP"),
    ("F2", 13, 150, 502, "Currency"),
    ("F1", 12, 150, 484, "EUR"),
]

# Une ligne en deux objets texte (police à chasse fixe, 7,2 pt d'avance à 12 pt),
# le premier finissant par une espace : un seul bloc à l'écran, deux objets
# dans le flux.
GRID_LINES = [
    ("F3", 12, 72, 400, "Facture 109 - 3542541 "),
    ("F3", 12, 230.4, 400, "100Q65"),
]


def build_pdf(lines):
    content = "".join(
        f"BT /{font} {size} Tf {x} {y} Td ({text}) Tj ET\n" for font, size, x, y, text in lines
    ).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 7 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    target.mkdir(parents=True, exist_ok=True)
    (target / "wire.pdf").write_bytes(build_pdf(WIRE_LINES))
    (target / "grid.pdf").write_bytes(build_pdf(GRID_LINES))
