# MD Reader (PWA)

Pembaca Markdown untuk Android: buka file .md dari HP atau langsung dari repo GitHub (publik & private).

## Pasang di Android (gratis via GitHub Pages)
1. Buat repo baru di GitHub (mis. `md-reader`), upload semua isi folder ini ke root repo.
2. Repo → Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)` → Save.
3. Tunggu ±1 menit, buka `https://<username>.github.io/md-reader/` di Chrome Android.
4. Menu ⋮ Chrome → **Add to Home screen / Install app**. Ikon "MD" muncul di layar utama.

## Repo private
Menu ⋯ → Token GitHub → buat *fine-grained token* dengan izin **Contents: Read-only** untuk repo yang dipilih. Token disimpan hanya di localStorage HP.

## Ekspor PDF
Buka file → menu ⋯ → **Ekspor ke PDF** → atur kertas/margin/ukuran teks → **Buat PDF** → di dialog cetak pilih **Simpan sebagai PDF**. Nama file PDF otomatis mengikuti nama file .md.
