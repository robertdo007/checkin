const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'data_check_in.csv');




/* ── Parse CSV ───────────────────────────────────── */
function parseCSV(text) {
    const lines = text.replace(/\r/g, '').trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).filter(Boolean).map(line => {
        const vals = line.split(',');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = (vals[i] || '').trim(); });
        return obj;
    });
}

/* ── Load athlete data ───────────────────────────── */
function loadAthletes() {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return parseCSV(raw);
}

/* ── Normalize string for comparison ─────────────── */
function norm(s) {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}


/* sdt */
function findAthlete(sdt) {
    const athletes = loadAthletes();
    return athletes.find(a =>
        a['sdt'].replace(/\D/g, '') === sdt.replace(/\D/g, '')
    ) || null;
}

/* ── Build result for athlete ────────────────────── */
function buildResult(a) {
    const contents = [
        {
            name: 'Newbie',
            bang: a['Newbie'],
            tran: a['Time_NB']
        },
        {
            name: 'HH 4.5',
            bang: a['HH_4.5'],
            tran: a['Time_HH']
        },
        {
            name: 'NN 4.3',
            bang: a['NN_4.3'],
            tran: a['Time_TD']
        },
    ];

    // Chỉ include nội dung mà vận động viên tham gia (bang !== 'KO' và có giá trị)
    const active = contents.filter(c =>
        c.bang &&
        norm(c.bang) !== 'ko' &&
        c.bang !== '' &&
        c.tran &&
        c.tran !== ''
    );

    return {
        ho_ten: a['ho_ten'],
        sdt: a['sdt'],
        noi_dung: active.map(c => ({
            ten: c.name,
            bang: c.bang.toUpperCase(),
            tran: c.tran,
        }))
    };
}
/* ── Helper: parse body ──────────────────────────── */
function readBody(req) {
    return new Promise((res, rej) => {
        let d = '';
        req.on('data', c => d += c);
        req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch (e) { rej(e); } });
        req.on('error', rej);
    });
}

function csvField(v) {
    const s = String(v ?? '').replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
}

/* ── HTTP Server ─────────────────────────────────── */
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const method = req.method.toUpperCase();
    const pathname = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    /* POST /checkin — lookup + save */
    if (method === 'POST' && pathname === '/checkin') {
        try {
            let { sdt, ho_ten } = await readBody(req);

            // 🔧 Xóa số 0 ở đầu
            sdt = String(sdt).trim();
            if (sdt.startsWith('0')) {
                sdt = sdt.substring(1);
            }
            console.log(`📱 Normalized SDT: ${sdt}`);
            console.log(`📱 Normalized Ho_Ten: ${ho_ten}`);

            if (!sdt) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'Thiếu thông tin' }));
                return;
            }

            const athlete = findAthlete(sdt);
            console.log(`🔍 Looking for SDT: "${sdt}"`);
            console.log(`📋 Found athlete:`, athlete);

            // ❌ Khách tham quan (không tìm thấy)
            if (!athlete) {
                console.log(`👤 Visitor: ${ho_ten} - ${sdt}`);

                // Update SheetDB (khách tham quan)
                try {
                    await fetch('https://sheetdb.io/api/v1/w5hwpycj8er4m', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            data: {
                                ho_ten: ho_ten,
                                sdt: sdt,
                                CHECK_IN: 'NEW'
                            }
                        })
                    });
                    console.log(`✅ Visitor added to sheet`);
                } catch (sheetError) {
                    console.error(`⚠️ Sheet error: ${sheetError.message}`);
                }
                // Save CSV
                const ts = new Date().toISOString();
                const row = [ts, ho_ten, sdt].map(csvField).join(',') + '\n';
                fs.appendFileSync(CHECKIN_FILE, row, 'utf8');

                // 🆕 Trả response visitor (không error)
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    isVisitor: true,
                    ho_ten: ho_ten,
                    sdt: sdt,
                    noi_dung: []
                }));
                return;
            }

            // ✅ Vận động viên (tìm thấy)
            console.log(`🎯 Building result for:`, athlete);
            const result = buildResult(athlete);
            console.log(`📊 Result:`, result);
            console.log(`📊 Result noi_dung:`, result.noi_dung);  // 🆕
            if (!result || !result.ho_ten) {
                throw new Error('buildResult failed - result is invalid');
            }


            

            // Update SheetDB
            try {
                const sheetResponse = await fetch(
                    `https://sheetdb.io/api/v1/w5hwpycj8er4m/sdt/${encodeURIComponent(result.sdt)}`,
                    {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            data: {
                                CHECK_IN: 'YES'
                            }
                        })
                    }
                );

                const text = await sheetResponse.text();
                console.log('Status:', sheetResponse.status);
                console.log(text);

            } catch (sheetError) {
                console.error(`⚠️ Sheet sync error: ${sheetError.message}`);
            }

            
        return;
    }

    /* GET /checkins — view saved check-ins */
    if (method === 'GET' && pathname === '/CHECKIN_FILE') {
        const csv = fs.readFileSync(CHECKIN_FILE, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const lines = csv.trim().split('\n').slice(1).filter(Boolean);
        res.end(JSON.stringify({ ok: true, total: lines.length, data: lines }));
        return;
    }

    /* GET /download — download checkin CSV */
    if (method === 'GET' && pathname === '/download') {
        res.writeHead(200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="CHECKIN_FILE.csv"',
        });
        res.end(fs.readFileSync(CHECKIN_FILE));
        return;
    }

    /* Serve index.html */
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(filePath));
    } else {
        res.writeHead(404); res.end('index.html not found');
    }
});

server.listen(PORT, () => {
    console.log(`\n🏸  Sport Check-in Server`);
    console.log(`   Website:  http://localhost:${PORT}`);
    console.log(`   Checkinfile: http://localhost:${PORT}/CHECKIN_FILE`);
    console.log(`   Download: http://localhost:${PORT}/download\n`);
});
