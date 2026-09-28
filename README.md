# Sainik Library

Docker-ready self-study library booking website.

## Payment flow

This version does **not use Razorpay**.

Students pay using the configured UPI ID through Google Pay, PhonePe, or another UPI app. The site generates a QR code and UPI link.

1. Student selects a seat.
2. Seat is held as `pending`.
3. Student pays the displayed amount.
4. Student clicks **I Have Paid** and sends the receipt/screenshot to the library WhatsApp.
5. Admin verifies the payment manually in the Admin Dashboard and clicks **Confirm Payment**.
6. Only after admin confirmation does the seat become `confirmed`/BOOKED.
7. Admin can later **Cancel Booking** to release the seat.
8. Unpaid pending holds expire automatically after `PAYMENT_HOLD_MINUTES`.

> A UPI deep link/QR code alone cannot reliably prove that a bank payment succeeded. Manual admin verification is therefore used in this version.

## Setup

Create `.env` from `.env.example`:

```env
UPI_ID=8765196654@upi
UPI_NAME=Sainik Library
PAYMENT_AMOUNT=2000
```

Set a strong admin password and JWT secret.

Then run:

```cmd
docker compose up --build
```

Open:

- Website: http://localhost:3001
- Admin: http://localhost:3001/admin.html


## Booking information & admin history

Online booking collects:
- Student name
- Father name
- Mobile number
- Full address
- Email (optional)
- Date, shift, plan and seat

Admin-only dashboard:
- Active bookings
- Full booking history
- Cancelled booking history
- Cancellation date/time
- Admin who cancelled the booking
- Cancellation reason
- Payment status

Cancelled records are retained instead of deleted, so the admin can see the complete history. Expired unpaid holds are also retained with the reason `Payment hold expired`.
