from pathlib import Path

path = Path(__file__).resolve().parents[1] / 'src/app/api/rezku/download-proxy/route.ts'
text = path.read_text()
marker = 'import { fetchTrustedRezkuWorkbook, trustedRezkuWorkbookUrl } from "@/lib/rezku-trusted-fetch";\n\n'
constant = 'const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";\n\n'
if marker not in text:
    raise RuntimeError('trusted Rezku fetch import was not generated')
if 'const BROWSER_USER_AGENT =' not in text:
    text = text.replace(marker, marker + constant, 1)
path.write_text(text)
print('Stage 5 Edge browser profile preserved')
