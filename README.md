# Surf Wala – Booking System

A booking system built for **Surf Wala**, a surf school with accommodation in Arambol, Goa (India).
It replaces manual booking through messages with a guided **booking chatbot** for customers and an
**admin dashboard** where the staff manage reservations, courses, instructors, rooms and prices.

## Features

**Booking chatbot (public)**
- Step-by-step booking flow (40+ conversation steps): surf lessons, accommodation or a Surf + Stay package
- Collects group size, swimming ability, surfing experience, children, dates, arrival time and contact details
- Checks real-time room availability and daily course capacity before offering a date
- Calculates prices automatically – seasonal pricing (4 seasons), multi-day packages, extra beds
- Stores conversation state per user, prepared for an Instagram messaging integration

**Admin dashboard (password protected)**
- Overview with statistics – today's and this week's bookings, pending reservations, occupancy rate
- Reservations list with filtering, status changes and booking detail
- Calendar view of surf sessions and room occupancy
- Management of courses, instructors, rooms, accommodation types and customers
- Editing of seasonal prices directly from the dashboard
- Automatic booking confirmation e-mail after a reservation is confirmed (Resend API)

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS, shadcn/ui (Radix UI), SWR, date-fns |
| Backend | Next.js Route Handlers (REST API), Middleware for authentication |
| Database | PostgreSQL via Supabase (with an in-memory fallback for local demo) |
| Integrations | Resend (e-mail) |

## Project structure

```
app/
  api/                 REST API (reservations, customers, courses, instructors,
                       rooms, accommodation, availability, seasonal-pricing, auth)
  chat-demo/           public booking chatbot
  dashboard/ …         admin pages (reservations, calendar, courses, settings …)
components/            chatbot, sidebar, tables, statistics cards, UI components
lib/
  pricing.ts           seasonal pricing and package price calculation
  room-inventory.ts    room types and capacities
  mock-store.ts        in-memory data store used when Supabase is not configured
  auth.ts              admin session helpers
  supabase/            Supabase clients (browser and server)
middleware.ts          protects admin pages and admin API endpoints
```

## REST API overview

| Endpoint | Methods | Access |
|---|---|---|
| `/api/availability` | GET | public |
| `/api/accommodation` | GET / POST | GET public, POST admin |
| `/api/accommodation/[id]` | GET, PUT, DELETE | admin |
| `/api/reservations` | GET / POST | POST public (chatbot), GET admin |
| `/api/reservations/[id]` | GET, PATCH, DELETE | admin |
| `/api/customers`, `/api/customers/[id]` | GET, POST, PATCH, DELETE | admin |
| `/api/courses`, `/api/courses/[id]` | GET, POST, PATCH, DELETE | GET public, rest admin |
| `/api/instructors`, `/api/instructors/[id]` | GET, POST, PATCH, DELETE | admin |
| `/api/rooms`, `/api/rooms/[id]` | GET, POST, PUT, DELETE | admin |
| `/api/seasonal-pricing` | GET / PUT | GET public, PUT admin |
| `/api/chatbot/conversation` | GET, POST, DELETE | public (bot integration) |
| `/api/auth`, `/api/logout` | POST | public |

## Getting started

Requirements: Node.js 20+ and pnpm.

```bash
git clone https://github.com/Anti746/surfwala-booking-system.git
cd surfwala-booking-system
pnpm install
cp .env.local.example .env.local   # then set at least ADMIN_PASSWORD
pnpm dev
```

- Booking chatbot: <http://localhost:3000>
- Admin dashboard: <http://localhost:3000/dashboard> (log in with `ADMIN_PASSWORD`)

Without Supabase credentials the app runs on built-in demo data, so it can be tried out right away.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Password for the admin dashboard |
| `NEXT_PUBLIC_SUPABASE_URL` | no | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | Supabase anon key |
| `RESEND_API_KEY` | no | API key for confirmation e-mails |
| `RESEND_FROM_EMAIL` | no | Sender address for e-mails |

Database tables used: `reservations`, `customers`, `courses`, `instructors`, `rooms`,
`accommodation_types`, `seasonal_pricing`, `conversation_states`.

## Security

- No passwords or API keys are stored in the code – everything is loaded from environment variables.
- The admin session cookie is `HttpOnly` and contains only a hash, not the password itself.
- Admin API endpoints (customer data, price and room management) are protected by middleware;
  only the endpoints the booking chatbot needs are public.

## Screenshots

_Add screenshots of the chatbot and the dashboard here._

## Author

**Antónia Krippnerová** – design and development of the whole application (frontend, REST API,
database, business logic). Built with the help of AI coding tools (v0.app).
