#!/usr/bin/env node
/**
 * sync.mjs — HBA Fidelity Email Sync
 * Legge email IMAP → popola tabelle ospiti/soggiorni su Supabase
 *
 * Variabili d'ambiente richieste (GitHub Secrets):
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
 *   SUPA_URL   (https://tdxpynjpyxaymkedfuic.supabase.co)
 *   SUPA_KEY   (service_role key — SOLO in GitHub Secrets, mai in codice)
 *
 * Uso:
 *   node sync.mjs [--days 30]   # analizza email degli ultimi N giorni (default 7)
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.SUPA_URL;
const SUPA_KEY = process.env.SUPA_KEY;   // service_role key
const IMAP_HOST = process.env.IMAP_HOST;
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASS = process.env.IMAP_PASS;

const DAYS_BACK = parseInt(process.argv[3] || process.argv[2]?.replace('--days=','') || '7');

if (!SUPA_URL || !SUPA_KEY || !IMAP_HOST || !IMAP_USER || !IMAP_PASS) {
  console.error('Mancano variabili d\'ambiente. Controlla: SUPA_URL, SUPA_KEY, IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS');
  process.exit(1);
}

const supabase = createClient(SUPA_URL, SUPA_KEY);

// ══════════════════════════════════════════════
// PARSER BOOKING.COM
// ══════════════════════════════════════════════
function parseBookingEmail(subject, text, html) {
  const body = text || html?.replace(/<[^>]+>/g, ' ') || '';

  // Estrai nome ospite
  let nome = null;
  const nomeMatch = body.match(/(?:Guest name|Nome ospite|Ospite)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i)
    || body.match(/(?:Dear|Gentile)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i)
    || subject.match(/Prenotazione di ([A-Z][a-z]+(?: [A-Z][a-z]+)+)/i);
  if (nomeMatch) nome = nomeMatch[1].trim();

  // Estrai date
  let checkIn = null, checkOut = null;
  const dateMatch = body.match(/(?:Check-in|Arrivo)[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const dateOutMatch = body.match(/(?:Check-out|Partenza)[:\s]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  if (dateMatch) checkIn = normalizeDate(dateMatch[1]);
  if (dateOutMatch) checkOut = normalizeDate(dateOutMatch[1]);

  // Estrai email ospite
  const emailMatch = body.match(/(?:Email ospite|Guest email|Contact)[:\s]+([\w.+-]+@[\w.-]+\.\w+)/i);
  const email = emailMatch ? emailMatch[1].toLowerCase() : null;

  // Estrai telefono
  const telMatch = body.match(/(?:Tel|Phone|Telefono)[:\s]+([+\d\s\-()]{8,20})/i);
  const telefono = telMatch ? telMatch[1].trim() : null;

  // Estrai camera
  const camMatch = body.match(/(?:Camera|Room|Stanza)[:\s#]+(\w+)/i);
  const camera = camMatch ? camMatch[1] : null;

  // Canale
  const canale = subject.toLowerCase().includes('booking') ? 'Booking.com'
    : subject.toLowerCase().includes('airbnb') ? 'Airbnb'
    : subject.toLowerCase().includes('expedia') ? 'Expedia'
    : 'email';

  return { nome, email, telefono, checkIn, checkOut, camera, canale };
}

// ══════════════════════════════════════════════
// PARSER EMAIL DIRETTE / GENERICO
// ══════════════════════════════════════════════
function parseDirectEmail(from, subject, text) {
  // Per email dirette, mittente = ospite
  const fromMatch = from?.match(/^([^<]+?)\s*(?:<|$)/);
  const nome = fromMatch ? fromMatch[1].trim().replace(/"/g, '') : null;
  const emailMatch = from?.match(/<?([\w.+-]+@[\w.-]+\.\w+)>?/);
  const email = emailMatch ? emailMatch[1].toLowerCase() : null;

  const body = text || '';
  const dateMatch = body.match(/(?:arriv|check.in|dal|from)\D{0,20}(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const dateOutMatch = body.match(/(?:parten|check.out|al|to)\D{0,20}(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
  const checkIn = dateMatch ? normalizeDate(dateMatch[1]) : null;
  const checkOut = dateOutMatch ? normalizeDate(dateOutMatch[1]) : null;

  return { nome, email, telefono: null, checkIn, checkOut, camera: null, canale: 'diretta' };
}

// ══════════════════════════════════════════════
// NORMALIZZA DATA → YYYY-MM-DD
// ══════════════════════════════════════════════
function normalizeDate(str) {
  if (!str) return null;
  const parts = str.split(/[\/\-\.]/);
  if (parts.length !== 3) return null;
  let [a, b, c] = parts.map(Number);
  // Scegli formato: se c > 31 è YYYY-MM-DD, altrimenti DD/MM/YYYY
  if (c > 31) {
    // DD/MM/YYYY
    const y = c < 100 ? 2000 + c : c;
    return `${y}-${String(b).padStart(2,'0')}-${String(a).padStart(2,'0')}`;
  }
  // Già YYYY-...
  return `${a}-${String(b).padStart(2,'0')}-${String(c).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════
// UPSERT OSPITE + SOGGIORNO
// ══════════════════════════════════════════════
let stats = { processed: 0, ospiti_new: 0, ospiti_updated: 0, soggiorni_new: 0, errors: 0 };

async function upsertOspiteESoggiorno(parsed) {
  const { nome, email, telefono, checkIn, checkOut, camera, canale } = parsed;
  if (!nome && !email) return; // skip se non abbiamo info minime

  stats.processed++;

  // 1. Trova o crea ospite
  let ospiteId = null;
  let ospite = null;

  if (email) {
    const { data: existing } = await supabase
      .from('ospiti').select('*').eq('email', email).single();
    if (existing) {
      ospite = existing;
      ospiteId = existing.id;
    }
  }

  if (!ospiteId && nome) {
    // Cerca per nome esatto (case insensitive)
    const { data: existing } = await supabase
      .from('ospiti').select('*')
      .ilike('nome', nome).limit(1);
    if (existing && existing.length > 0) {
      ospite = existing[0];
      ospiteId = ospite.id;
    }
  }

  if (!ospiteId) {
    // Crea nuovo ospite
    const { data: newOspite, error } = await supabase
      .from('ospiti').insert({
        nome: nome || email,
        email: email || null,
        telefono: telefono || null,
        lingua: 'it',
        n_soggiorni: 0
      }).select().single();

    if (error) {
      console.error('Errore creazione ospite:', error.message, { nome, email });
      stats.errors++;
      return;
    }
    ospite = newOspite;
    ospiteId = newOspite.id;
    stats.ospiti_new++;
    console.log(`  ✚ Nuovo ospite: ${nome || email}`);
  } else {
    // Aggiorna campi mancanti
    const updates = {};
    if (email && !ospite.email) updates.email = email;
    if (telefono && !ospite.telefono) updates.telefono = telefono;
    if (nome && ospite.nome !== nome && !ospite.email) updates.nome = nome;
    if (Object.keys(updates).length > 0) {
      await supabase.from('ospiti').update(updates).eq('id', ospiteId);
      stats.ospiti_updated++;
    }
  }

  // 2. Aggiungi soggiorno se abbiamo le date e non è duplicato
  if (checkIn && checkOut) {
    const { data: existingSogg } = await supabase
      .from('soggiorni').select('id')
      .eq('ospite_id', ospiteId)
      .eq('check_in', checkIn)
      .eq('check_out', checkOut)
      .limit(1);

    if (!existingSogg || existingSogg.length === 0) {
      const { error: soggErr } = await supabase.from('soggiorni').insert({
        ospite_id: ospiteId,
        check_in: checkIn,
        check_out: checkOut,
        camera: camera || null,
        canale: canale || 'email'
      });
      if (soggErr) {
        console.error('Errore soggiorno:', soggErr.message);
        stats.errors++;
      } else {
        stats.soggiorni_new++;
        console.log(`  📅 Soggiorno: ${checkIn} → ${checkOut}`);
        // Aggiorna contatori ospite
        await supabase.rpc('update_ospite_stats', { p_ospite_id: ospiteId }).catch(() => {
          // fallback: aggiorna manualmente
          supabase.from('ospiti').update({
            n_soggiorni: (ospite.n_soggiorni || 0) + 1,
            ultimo_soggiorno: checkOut,
            primo_soggiorno: ospite.primo_soggiorno || checkIn,
            updated_at: new Date().toISOString()
          }).eq('id', ospiteId);
        });
      }
    }
  }
}

// ══════════════════════════════════════════════
// LETTURA EMAIL IMAP
// ══════════════════════════════════════════════
function readEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: IMAP_USER,
      password: IMAP_PASS,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) return reject(err);

        const since = new Date();
        since.setDate(since.getDate() - DAYS_BACK);
        const sinceStr = since.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

        imap.search(['ALL', ['SINCE', sinceStr]], (err, results) => {
          if (err) return reject(err);
          if (!results || results.length === 0) {
            console.log('Nessuna email trovata negli ultimi', DAYS_BACK, 'giorni');
            imap.end();
            return resolve([]);
          }

          console.log(`Trovate ${results.length} email da analizzare`);
          const emails = [];
          const f = imap.fetch(results, { bodies: '', struct: true });

          f.on('message', (msg) => {
            let buffer = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            });
            msg.once('end', () => {
              emails.push(buffer);
            });
          });

          f.once('error', (err) => console.error('Fetch error:', err));
          f.once('end', () => {
            imap.end();
            resolve(emails);
          });
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

// ══════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════
async function main() {
  console.log(`\n🏨 HBA Fidelity Sync — ultimi ${DAYS_BACK} giorni`);
  console.log(`📡 Supabase: ${SUPA_URL}`);
  console.log(`📧 IMAP: ${IMAP_USER}@${IMAP_HOST}\n`);

  let emailBuffers;
  try {
    emailBuffers = await readEmails();
  } catch (err) {
    console.error('Errore IMAP:', err.message);
    process.exit(1);
  }

  for (const rawEmail of emailBuffers) {
    try {
      const parsed = await simpleParser(rawEmail);
      const { from, subject, text, html } = parsed;
      const fromStr = from?.text || '';
      const subjectStr = subject || '';

      console.log(`\n📨 ${subjectStr.substring(0,80)}`);
      console.log(`   Da: ${fromStr.substring(0,60)}`);

      // Decide parser
      const isBooking = subjectStr.toLowerCase().includes('booking')
        || fromStr.toLowerCase().includes('booking.com')
        || subjectStr.toLowerCase().includes('prenotazione')
        || subjectStr.toLowerCase().includes('reservation')
        || subjectStr.toLowerCase().includes('new reservation');

      let result;
      if (isBooking) {
        result = parseBookingEmail(subjectStr, text, html);
      } else {
        result = parseDirectEmail(fromStr, subjectStr, text);
      }

      if (result.nome || result.email) {
        await upsertOspiteESoggiorno(result);
      } else {
        console.log('  ⚠ Email non riconoscibile, skip');
      }
    } catch (err) {
      console.error('Errore parsing email:', err.message);
      stats.errors++;
    }
  }

  console.log('\n' + '═'.repeat(50));
  console.log(`✅ Sync completato!`);
  console.log(`   Email analizzate:    ${emailBuffers.length}`);
  console.log(`   Dati estratti:       ${stats.processed}`);
  console.log(`   Ospiti nuovi:        ${stats.ospiti_new}`);
  console.log(`   Ospiti aggiornati:   ${stats.ospiti_updated}`);
  console.log(`   Soggiorni aggiunti:  ${stats.soggiorni_new}`);
  console.log(`   Errori:              ${stats.errors}`);
  console.log('═'.repeat(50) + '\n');
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
