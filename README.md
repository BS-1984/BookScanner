# Büchersammlung

Web-App (PWA) für Android: Bücher per Barcode erfassen, durchsuchen und beim Einkauf mit der eigenen Sammlung abgleichen.
Alle Daten liegen lokal auf dem Smartphone (IndexedDB). Es gibt keinen Server und kein Konto.

## Funktionen
- **Erfassen**: Barcode scannen, Buchdaten werden automatisch geladen (Google Books, Deutsche Nationalbibliothek, Open Library).
  Die *Schnellerfassung* speichert ohne Nachfrage, um viele Bücher am Stück aufzunehmen.
- **Sammlung**: Suche über Titel, Autor, ISBN, Standort, Tags und Notizen; sortierbar.
- **Einkauf (Auto-Abgleich)**: Kamera scannt laufend.
  🔴 *Hast du schon*, 🟡 *Ähnliche Ausgabe vorhanden* (gleicher Titel und Autor, andere ISBN), 🟢 *Nicht in deiner Sammlung*.
  Der ISBN-Abgleich funktioniert auch offline.
- **Mehr**: Backup als JSON (Download oder Teilen, z. B. nach Google Drive), CSV-Export für Excel, Import, fehlende Daten nachladen.

## Installation aufs Handy
Die Kamera funktioniert im Browser nur über **HTTPS**. Die App muss also einmal irgendwo gehostet werden, z. B. kostenlos bei:

- **GitHub Pages**: Repository anlegen, Dateien hochladen, unter *Settings → Pages* den Branch `main` aktivieren.
- **Netlify Drop** (https://app.netlify.com/drop): den Ordner per Drag & Drop hochladen.

Danach die Adresse in **Chrome auf Android** öffnen → Menü ⋮ → **App installieren**.
Ab dann läuft die App vom Homescreen, auch ohne Internet. Ein langer Druck aufs App-Icon bietet die Abkürzung *Einkaufsmodus*.

> Die Bücherdaten liegen nur auf dem Handy. Regelmäßig unter *Mehr → Backup teilen* sichern.
> Die App erinnert nach 30 Tagen ohne Backup daran.

## Lokal testen (PC)
```
python -m http.server 8000
```
Dann http://localhost:8000 öffnen. Scannen geht am PC nicht, die ISBN lässt sich aber eintippen.

## Updates
Nach Änderungen an den App-Dateien in `sw.js` die `VERSION` erhöhen, damit installierte Apps die neue Version laden.
