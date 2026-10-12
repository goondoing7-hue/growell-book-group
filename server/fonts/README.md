# Pretendard for server PDF attachments

Unmodified static OpenType fonts from the official Pretendard v1.3.9 release:

- https://github.com/orioncactus/pretendard/tree/v1.3.9/packages/pretendard/dist/public/static
- Copyright (c) 2021, Kil Hyung-jin. Reserved Font Name: Pretendard.
- Licensed under SIL Open Font License 1.1, included in `OFL.txt`.

These server assets are embedded as subsets in generated Korean meeting-record
PDFs. They are not copied into the public website build. Keep the license with
both font files when packaging or redistributing the server source.

The unmodified variable monochrome Noto Emoji font is an emoji fallback from
https://github.com/google/fonts/tree/main/ofl/notoemoji, under SIL Open Font
License 1.1 (`NotoEmoji-OFL.txt`). It prevents emoji in operator-authored text
from becoming missing squares; other unsupported glyphs stop PDF delivery with
a safe error instead of silently omitting authored content.
