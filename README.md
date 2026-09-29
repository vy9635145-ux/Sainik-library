# Sainik Library

## Included updates
- Permanent shift-based seat locking: Morning booking locks Morning + Full Day; Evening booking locks Evening + Full Day; Full Day locks all three.
- Active bookings remain booked until admin cancellation.
- SQLite database persists through Docker using `./data:/data`.
- Month-wise booking/cancellation history with admin-controlled deletion of cancelled records.
- Responsive admin dashboard with horizontally scrollable wide tables so content does not overflow the frame.
- Admin-only Success Students Showcase:
  - Add unlimited student records
  - Upload student photo
  - Add bio/achievement details
  - Add selected/qualified-for information
  - Add selected-at/place information
  - Add library start and end period
  - Edit or delete any showcase record
- Public success-student section appears above Premium Facilities and auto-slides on desktop/mobile.

## Run
```cmd
docker compose down
docker rm -f sainik-library

docker compose up --build
```

Do not delete the `data` folder if you want to keep existing bookings/history.
