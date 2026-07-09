require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');

// ===== إعداد التطبيق =====
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3000;

// ===== تخزين البيانات =====
const groupsData = new Map();
const logsFile = path.join(__dirname, 'logs.json');

// ===== إعداد عميل واتساب =====
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// ===== عرض QR Code =====
client.on('qr', qr => {
    console.log('📱 امسح هذا الكود لتسجيل الدخول:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ تم الاتصال بنجاح!');
    console.log('🔄 جاري تحميل المجموعات...');
    startMonitoring();
});

client.on('auth_failure', msg => {
    console.error('❌ فشل المصادقة:', msg);
});

// ===== حفظ السجل =====
function saveLog(update) {
    try {
        let logs = [];
        if (fs.existsSync(logsFile)) {
            logs = JSON.parse(fs.readFileSync(logsFile));
        }
        logs.push({
            ...update,
            timestamp: new Date().toISOString()
        });
        // الاحتفاظ بآخر 1000 سجل فقط
        if (logs.length > 1000) logs = logs.slice(-1000);
        fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
    } catch (error) {
        console.error('خطأ في حفظ السجل:', error);
    }
}

// ===== بدء المراقبة =====
async function startMonitoring() {
    try {
        const chats = await client.getChats();
        const groupChats = chats.filter(chat => chat.isGroup);
        
        console.log(`📊 تم العثور على ${groupChats.length} مجموعة`);
        
        // عرض معرفات المجموعات المتاحة
        console.log('\n📋 معرفات المجموعات المتاحة:');
        groupChats.forEach((chat, index) => {
            console.log(`${index + 1}. ${chat.name} : ${chat.id._serialized}`);
        });

        // ===== ضع هنا معرفات حلقاتك =====
        const groupIds = [
            // مثال: '1203631234567890@g.us',
            // أضف معرفات حلقاتك هنا
        ];

        // إذا لم يتم تحديد مجموعات، استخدم جميع المجموعات
        let targetGroups = groupIds;
        if (groupIds.length === 0) {
            console.log('⚠️ لم يتم تحديد مجموعات، سيتم مراقبة جميع المجموعات');
            targetGroups = groupChats.map(chat => chat.id._serialized);
        }

        // تحميل البيانات الأولية
        for (const groupId of targetGroups) {
            try {
                const chat = await client.getChatById(groupId);
                if (chat && chat.isGroup) {
                    const participants = await chat.getParticipants();
                    groupsData.set(groupId, {
                        name: chat.name,
                        participants: participants.map(p => ({
                            id: p.id._serialized,
                            name: p.pushname || p.id.user || 'مستخدم'
                        })),
                        lastUpdate: new Date()
                    });
                    console.log(`✅ تم تحميل: ${chat.name} (${participants.length} عضو)`);
                }
            } catch (error) {
                console.error(`❌ خطأ في تحميل المجموعة ${groupId}:`, error.message);
            }
        }

        console.log(`\n🚀 بدء المراقبة... (${groupsData.size} مجموعة)`);
        
        // ===== مراقبة التغييرات كل 30 ثانية =====
        setInterval(async () => {
            for (const [groupId, oldData] of groupsData) {
                try {
                    const chat = await client.getChatById(groupId);
                    if (!chat) continue;

                    const currentParticipants = await chat.getParticipants();
                    const currentMap = new Map();
                    currentParticipants.forEach(p => {
                        currentMap.set(p.id._serialized, {
                            id: p.id._serialized,
                            name: p.pushname || p.id.user || 'مستخدم'
                        });
                    });

                    const oldMap = new Map();
                    oldData.participants.forEach(p => {
                        oldMap.set(p.id, p);
                    });

                    // اكتشاف التغييرات
                    const left = [];
                    const joined = [];

                    for (const [id, p] of oldMap) {
                        if (!currentMap.has(id)) {
                            left.push(p.name);
                        }
                    }

                    for (const [id, p] of currentMap) {
                        if (!oldMap.has(id)) {
                            joined.push(p.name);
                        }
                    }

                    if (left.length > 0 || joined.length > 0) {
                        // تحديث البيانات
                        groupsData.set(groupId, {
                            name: chat.name,
                            participants: currentParticipants.map(p => ({
                                id: p.id._serialized,
                                name: p.pushname || p.id.user || 'مستخدم'
                            })),
                            lastUpdate: new Date()
                        });

                        const update = {
                            groupId,
                            groupName: chat.name,
                            left,
                            joined,
                            totalMembers: currentParticipants.length,
                            timestamp: new Date().toLocaleString('ar-SA')
                        };

                        // حفظ السجل
                        saveLog(update);

                        // إرسال التحديث للواجهة
                        io.emit('update', update);

                        // طباعة في الكونسول
                        if (left.length > 0) {
                            console.log(`🚪 غادر: ${left.join(', ')} من ${chat.name}`);
                        }
                        if (joined.length > 0) {
                            console.log(`👋 انضم: ${joined.join(', ')} إلى ${chat.name}`);
                        }
                    }
                } catch (error) {
                    console.error(`خطأ في مراقبة ${groupId}:`, error.message);
                }
            }
        }, 30000);

    } catch (error) {
        console.error('خطأ في بدء المراقبة:', error);
    }
}

// ===== تقديم الملفات الثابتة =====
app.use(express.static('public'));

// ===== API إضافية =====
app.get('/api/groups', (req, res) => {
    const data = Array.from(groupsData.entries()).map(([id, data]) => ({
        id,
        name: data.name,
        participants: data.participants,
        total: data.participants.length,
        lastUpdate: data.lastUpdate
    }));
    res.json(data);
});

app.get('/api/logs', (req, res) => {
    try {
        if (fs.existsSync(logsFile)) {
            const logs = JSON.parse(fs.readFileSync(logsFile));
            res.json(logs.slice(-50)); // آخر 50 سجل
        } else {
            res.json([]);
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
    console.log('👤 مستخدم جديد متصل');
    
    // إرسال البيانات الحالية
    const allData = Array.from(groupsData.entries()).map(([id, data]) => ({
        id,
        name: data.name,
        participants: data.participants,
        total: data.participants.length,
        lastUpdate: data.lastUpdate
    }));
    socket.emit('initialData', allData);

    socket.on('disconnect', () => {
        console.log('👤 مستخدم غادر');
    });
});

// ===== تشغيل الخادم =====
server.listen(PORT, () => {
    console.log(`\n🌐 الخادم يعمل على:`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   http://127.0.0.1:${PORT}`);
    console.log('\n📱 افتح الرابط في المتصفح لمشاهدة الواجهة\n');
});

// ===== تشغيل العميل =====
client.initialize();

// ===== معالجة الأخطاء =====
process.on('unhandledRejection', (error) => {
    console.error('خطأ غير متوقع:', error);
});
