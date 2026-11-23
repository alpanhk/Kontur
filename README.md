# TopoKontur — Ekstraksi Elevasi HD, Peta Kontur & Ekspor CAD/GIS (UTM)

Aplikasi Next.js + PostgreSQL (Drizzle ORM) berfokus pada **koordinat utama UTM (WGS84, satuan meter)** dan **data elevasi beresolusi tinggi**:

1. **Sumber Elevasi HD & Cepat**:
   - **Copernicus DEM GLO-30 HD (Default)** — Float32 ilmiah (ESA/Airbus via AWS Open Data COG) dengan interpolasi **Catmull-Rom Bikubik**, presisi vertikal sub-sentimeter, hingga 5.000 titik/batch tanpa batas rate.
   - **AWS Terrain Tiles HD (Terrarium z15)** — Grid elevasi 24-bit sub-meter (~5 m/piksel, interpolasi bikubik), sangat cepat hingga 50.000 titik.
   - Tambahan: OpenTopoData SRTM 30 m / ASTER 30 m, Copernicus 90 m (Open-Meteo), dan Google Elevation API (`GOOGLE_MAPS_API_KEY`).
2. **Gambar & Impor Fleksibel**:
   - Peta **Satelit Hybrid (dengan label jalan/wilayah)**, pencarian lokasi & koordinat **UTM (`E, N`) / Lat, Lon**, pembacaan koordinat UTM real-time di kursor.
   - Gambar **Poligon, Kotak, Garis (profil + koridor kontur), Titik**, dan **Cek Elevasi**.
   - Impor **`.kml` / `.kmz`** dari Google Earth Pro, **`.geojson`**, serta tempel/impor koordinat **UTM (Easting, Northing)** maupun WGS84 (`.csv` / `.txt`).
3. **Kontur Beresolusi Tinggi**:
   - **Upsampling bikubik sub-grid (1×, 2×, 4×)** + **penghalusan garis Chaikin** + penempatan label kontur indeks anti-tumpang tindih.
4. **Ekspor Lengkap CAD & GIS (Koordinat Utama: UTM)**:
   - **DXF 3D (AutoCAD R12)** — Koordinat UTM (meter), kontur ber-elevasi (siap buat TIN Surface di Civil 3D), `*ACTIVE VPORT` auto-zoom tepat ke koordinat UTM, serta **Grid Koordinat & Bingkai UTM**.
   - **XYZ / PNEZD UTM (`.txt`)** — Siap impor ke **Autodesk Civil 3D, Surfer, Global Mapper, QGIS**.
   - **Esri ASCII DEM Grid (`.asc`) + `.prj` (WKT UTM)** — Permukaan DEM raster untuk **QGIS, Global Mapper, ArcGIS, Surfer, Civil 3D**.
   - **GeoJSON 3D UTM (`EPSG:326xx/327xx`)**, **CSV UTM Lengkap**, **KML 3D (Google Earth Pro)**, **Paket Lengkap `.ZIP`**, dan **DWG** (bila `DWG_CONVERTER_COMMAND` dikonfigurasi).

## Menjalankan

```bash
npm install
npm run dev
```

Aplikasi langsung berjalan tanpa perlu menginstal server PostgreSQL terpisah karena sudah dilengkapi **PostgreSQL lokal terintegrasi (PGlite)** yang otomatis menyimpan data di `./data/pglite` dan menginisialisasi tabel secara otomatis.

Variabel `.env` (opsional — lihat `.env.example`):
- `DATABASE_URL` — opsional; isi `postgresql://...` bila ingin menggunakan server PostgreSQL eksternal (kosongkan untuk memakai PGlite lokal otomatis)
- `GOOGLE_MAPS_API_KEY` — opsional, mengaktifkan Google Elevation API
- `DWG_CONVERTER_COMMAND` — opsional, perintah konverter eksternal DXF → DWG (mis. ODA File Converter)
