/* =====================================================================
   shared/calendar.js - "Add to calendar" for a studio booking
   ---------------------------------------------------------------------
   calendarEvent(booking)  -> a plain event object (or null if the start time is not a known slot)
   downloadIcs(event)      -> saves a .ics file (Apple Calendar, Outlook, Android and most others open it)
   googleCalendarUrl(ev)   -> a link that opens Google Calendar with the event filled in

   Times: slots are Manila time (UTC+8, no daylight saving), so the file is written in UTC.
   The event UID is the booking reference, and SEQUENCE grows with time, so adding the same
   booking again after a reschedule replaces the old entry in most calendar apps instead of
   creating a second one. Two alarms are added: 1 day before (the last moment to change or
   cancel) and 2 hours before. No database changes.
   ===================================================================== */

import { SLOTS, endTime, manilaTS } from './utils.js';
import { VENUE } from './venue.js';

const p2 = n => String(n).padStart(2, '0');

/* Date -> 20261112T070000Z */
const stamp = d => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}`
    + `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;

/* ICS text values: escape \ ; , and line breaks */
const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/* ICS lines may not be longer than 75 octets: fold longer ones with CRLF + a space */
function fold(line) {
    const out = [];
    let rest = line;
    while (new TextEncoder().encode(rest).length > 74) {
        let cut = 74;
        while (new TextEncoder().encode(rest.slice(0, cut)).length > 74)
            cut--;
        out.push(rest.slice(0, cut));
        rest = ' ' + rest.slice(cut);
    }
    out.push(rest);
    return out.join('\r\n');
}

/* b = { ref, studio (the id shown as "Studio 2"), date 'YYYY-MM-DD', start '3:00 PM', hours, pending } */
export function calendarEvent(b) {
    const idx = SLOTS.indexOf(b.start);
    if (idx < 0 || !b.date || !b.hours)
        return null;
    const hour = 10 + idx;
    const start = new Date(manilaTS(b.date, hour));
    const end = new Date(manilaTS(b.date, hour + b.hours));
    if (isNaN(start) || isNaN(end))
        return null;
    const desc = [
        `Booking reference: ${b.ref}`,
        `Time: ${b.start} to ${endTime(b.start, b.hours)}`,
        b.pending
            ? 'Status: waiting for staff to verify your payment. This entry is tentative until you get the confirmation.'
            : 'Status: confirmed.',
        'Pay any remaining balance at the studio when you arrive.',
        'Changes and cancellations close 24 hours before your session.',
        `Questions? ${VENUE.phone}`
    ].join('\n');
    return {
        ref: b.ref,
        title: `Studio ${b.studio} at ${VENUE.name}${b.pending ? ' (pending)' : ''}`,
        start,
        end,
        location: `${VENUE.name}, ${VENUE.address}`,
        desc,
        pending: !!b.pending
    };
}

export function buildIcs(ev) {
    const alarm = (trigger, text) => [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `TRIGGER:${trigger}`,
        `DESCRIPTION:${icsText(text)}`,
        'END:VALARM'
    ];
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        `PRODID:-//${VENUE.name}//Booking//EN`,
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${ev.ref}@towerofdove`,
        `DTSTAMP:${stamp(new Date())}`,
        `SEQUENCE:${Math.floor(Date.now() / 1000)}`,
        `DTSTART:${stamp(ev.start)}`,
        `DTEND:${stamp(ev.end)}`,
        `SUMMARY:${icsText(ev.title)}`,
        `LOCATION:${icsText(ev.location)}`,
        `DESCRIPTION:${icsText(ev.desc)}`,
        `STATUS:${ev.pending ? 'TENTATIVE' : 'CONFIRMED'}`,
        ...alarm('-P1D', `Your rehearsal is tomorrow. Last chance to change or cancel (${ev.ref}).`),
        ...alarm('-PT2H', `Rehearsal at ${VENUE.name} in 2 hours.`),
        'END:VEVENT',
        'END:VCALENDAR'
    ];
    return lines.map(fold).join('\r\n') + '\r\n';
}

export function downloadIcs(ev) {
    if (!ev)
        return false;
    const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tower-of-dove-${ev.ref}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
}

export function googleCalendarUrl(ev) {
    if (!ev)
        return '#';
    const q = new URLSearchParams({
        action: 'TEMPLATE',
        text: ev.title,
        dates: `${stamp(ev.start)}/${stamp(ev.end)}`,
        details: ev.desc,
        location: ev.location
    });
    return 'https://calendar.google.com/calendar/render?' + q.toString();
}
