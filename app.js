// Import Firebase Functions 
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getFirestore, collection, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// Firebase Config ของคุณ
const firebaseConfig = {
    apiKey: "AIzaSyCJ-E8bN9nz_BWKTNofz7ccuVoo6m8LyAU",
    authDomain: "suchart-915bd.firebaseapp.com",
    projectId: "suchart-915bd",
    storageBucket: "suchart-915bd.firebasestorage.app",
    messagingSenderId: "94380768305",
    appId: "1:94380768305:web:c4705ea3e0d53e1b61a910",
    measurementId: "G-2LNYQS3M52"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Google Sheet Setup
const SHEET_ID = '1WQ790i1c8STFzWZEDtuK_NXg202lqEIh4OHfQ8qYGHo'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

let locations = [];
let announcedPlaces = new Set(); // จัดการการอ่านเสียงสปีช (ลบเมื่อห่างเกิน 80m)
let visitedPlaces = new Set();   // จัดการความคืบหน้า Progress บน UI (จำถาวรในหน้านั้น)
let checkedInPlaces = new Set(); // จัดการประวัติการกดปุ่มเช็คอิน ป้องกันการส่งขึ้น Firebase ซ้ำ
let watchId = null;

// Firebase Session และพิกัดปัจจุบัน
let sessionDocRef = null;
let sessionStartTime = null;
let currentLat = null;
let currentLng = null;

// เข็มทิศนำทางและตัวแปรเช็คอิน
let currentHeading = 0;
let targetLat = null;
let targetLng = null;
let activeCheckInLocation = null; // เก็บข้อมูลสถานที่ปัจจุบันที่สามารถกดเช็คอินได้

// โหลดข้อมูลจาก Google Sheet
function fetchLocations() {
    Papa.parse(CSV_URL, {
        download: true,
        header: true,
        complete: function(results) {
            locations = results.data.filter(loc => loc.lat && loc.lng);
            document.getElementById('status').innerText = `โหลดข้อมูลพร้อมแล้ว ${locations.length} จุด`;
            
            const totalEl = document.getElementById('totalCount');
            if(totalEl) totalEl.innerText = locations.length;
        },
        error: function(err) {
            document.getElementById('status').innerText = 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
        }
    });
}

// คำนวณระยะทางทางภูมิศาสตร์ (Haversine Formula)
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; 
}

// คำนวณองศาทิศทางระหว่างพิกัดสองจุด (Bearing Angle)
function getBearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;
    const dLon = (lon2 - lon1) * toRad;
    lat1 = lat1 * toRad;
    lat2 = lat2 * toRad;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * toDeg;
    return (bearing + 360) % 360; 
}

// อัปเดตและหมุนหัวลูกศรทิศทางนำทาง
function updateArrow() {
    if (targetLat === null || targetLng === null || currentLat === null || currentLng === null) return;
    const bearing = getBearing(currentLat, currentLng, targetLat, targetLng);
    let arrowAngle = bearing - currentHeading;
    const navArrow = document.getElementById('navArrow');
    if (navArrow) {
        navArrow.style.transform = `rotate(${arrowAngle}deg)`;
    }
}

// ระบบเสียงพูดสังเคราะห์ Text-to-Speech (3 ภาษา)
function speak(text, lang) {
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9; 
    window.speechSynthesis.speak(utterance);
}

// สร้างเซสชันบันทึกข้อมูลหลักลงใน Firebase
async function startFirebaseSession() {
    sessionStartTime = new Date();
    try {
        const docRef = await addDoc(collection(db, "visitor_logs"), {
            start_time: sessionStartTime.toISOString(),
            device_info: navigator.userAgent,
            last_lat: null,
            last_lng: null,
            duration_seconds: 0
        });
        sessionDocRef = docRef;
    } catch (e) {
        console.error("Firebase Connection Error: ", e);
    }
}

// ซิงค์พิกัดผู้ใช้ลงเซสชันฐานข้อมูลหลักทุกๆ 15 วินาที
setInterval(async () => {
    if (sessionDocRef && currentLat && currentLng && sessionStartTime) {
        const duration = Math.floor((new Date() - sessionStartTime) / 1000); 
        try {
            await updateDoc(sessionDocRef, {
                last_lat: currentLat,
                last_lng: currentLng,
                duration_seconds: duration
            });
        } catch (e) {}
    }
}, 15000);

// เริ่มการติดตามตำแหน่ง (Geolocation API)
function startTracking() {
    if (!navigator.geolocation) {
        alert("เบราว์เซอร์ไม่รองรับระบบระบุตำแหน่ง GPS");
        return;
    }

    document.getElementById('status').innerText = "กำลังค้นหาตำแหน่งของท่าน...";
    speak(" ", "th-TH");
    startFirebaseSession();

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            currentLat = position.coords.latitude;
            currentLng = position.coords.longitude;
            
            document.getElementById('status').innerHTML = `พิกัดปัจจุบัน:<br>Lat: ${currentLat.toFixed(5)}<br>Lng: ${currentLng.toFixed(5)}`;

            let closestLocation = null;
            let absoluteNearestLoc = null; 
            let minDistance = Infinity;
            let minAbsoluteDistance = Infinity;

            locations.forEach(loc => {
                const distance = getDistance(currentLat, currentLng, parseFloat(loc.lat), parseFloat(loc.lng));
                
                // ค้นหาจุดนิทรรศการที่ใกล้ที่สุดในทุกๆ พื้นที่ เพื่อบอกระยะทางและทิศทาง
                if (distance < minAbsoluteDistance) {
                    minAbsoluteDistance = distance;
                    absoluteNearestLoc = loc;
                }
                
                // ตรวจสอบพื้นที่ในระยะรัศมีเป้าหมาย 50 เมตร
                if (distance <= 50) {
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestLocation = loc;
                    }
                }
                
                // ล้างสถานะคิวเสียงอ่านสปีชเมื่อผู้ใช้ออกจากรัศมี 80 เมตร
                if (distance > 80 && announcedPlaces.has(loc.id)) {
                    announcedPlaces.delete(loc.id);
                }
            });

            // อัปเดตลูกศรนำทาง, ชื่อสถานที่ และตัวเลขระยะทางแบบเรียลไทม์
            if (absoluteNearestLoc) {
                targetLat = parseFloat(absoluteNearestLoc.lat);
                targetLng = parseFloat(absoluteNearestLoc.lng);
                updateArrow(); 
                
                const nameEl = document.getElementById('targetName');
                if (nameEl) {
                    window.currentTargetNameString = absoluteNearestLoc.name_th || absoluteNearestLoc.name || absoluteNearestLoc.title_th || "จุดกิจกรรม";
                    nameEl.innerText = window.currentTargetNameString;
                }

                const distEl = document.getElementById('distanceValue');
                if (distEl) {
                    if (minAbsoluteDistance >= 1000) {
                        distEl.innerText = (minAbsoluteDistance / 1000).toFixed(2) + " กม.";
                    } else {
                        distEl.innerText = Math.round(minAbsoluteDistance) + " ม.";
                    }
                }
            }

            // จัดการเมื่อผู้ใช้เข้าสู่รัศมี 50 เมตร (เริ่มสปีชเสียงพูด + แสดงปุ่มเช็คอิน)
            if (closestLocation) {
                activeCheckInLocation = closestLocation;
                const checkInBtn = document.getElementById('checkInBtn');
                
                if (checkInBtn && !checkInBtn.classList.contains('active')) {
                    const locName = closestLocation.name_th || closestLocation.name || closestLocation.title_th || "จุดกิจกรรม";
                    
                    // ปรับเปลี่ยนข้อความบนปุ่มกดและเปิดปุ่มขึ้นมา
                    if (checkedInPlaces.has(closestLocation.id)) {
                        checkInBtn.innerText = "🎉 เช็คอินสำเร็จแล้ว!";
                        checkInBtn.disabled = true;
                    } else {
                        checkInBtn.innerText = `✅ กดเพื่อเช็คอินที่: ${locName}`;
                        checkInBtn.disabled = false;
                    }
                    checkInBtn.classList.add('active');
                }

                // จัดการเรื่องการแจ้งเตือนเสียงสปีชและเอฟเฟกต์หน้าจอกระพริบ
                if (!announcedPlaces.has(closestLocation.id)) {
                    announcedPlaces.add(closestLocation.id); 
                    
                    visitedPlaces.add(closestLocation.id);
                    const visitedEl = document.getElementById('visitedCount');
                    if(visitedEl) visitedEl.innerText = visitedPlaces.size;

                    window.speechSynthesis.cancel(); 
                    
                    document.body.classList.add('found-location');
                    document.getElementById('main-container').classList.add('found-location');
                    
                    setTimeout(() => {
                        document.body.classList.remove('found-location');
                        document.getElementById('main-container').classList.remove('found-location');
                    }, 1500);
                    
                    speak(closestLocation.info_th, 'th-TH');
                    speak(closestLocation.info_en, 'en-US');
                    speak(closestLocation.info_cn, 'zh-CN');
                }
            } else {
                // หากไม่ได้อยู่ในรัศมีกิจกรรม 50 เมตรของจุดใดเลย ให้ซ่อนปุ่มเช็คอินออกไป
                activeCheckInLocation = null;
                const checkInBtn = document.getElementById('checkInBtn');
                if (checkInBtn) {
                    checkInBtn.classList.remove('active');
                }
            }
        },
        (error) => {
            document.getElementById('status').innerText = "โปรดอนุญาตและเปิดระบบระบุตำแหน่ง GPS";
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );
}

// สั่งงานพฤติกรรมเมื่อคลิกปุ่มเช็คอินสถานที่นิทรรศการ
document.getElementById('checkInBtn').addEventListener('click', async () => {
    if (!activeCheckInLocation) return;
    
    const checkInBtn = document.getElementById('checkInBtn');
    checkInBtn.disabled = true;
    checkInBtn.innerText = "⏳ กำลังบันทึกการเช็คอิน...";

    const locId = activeCheckInLocation.id;
    const locName = activeCheckInLocation.name_th || activeCheckInLocation.name || activeCheckInLocation.title_th || "ไม่ระบุชื่อ";

    try {
        // บันทึกประวัติส่งไปคอลเลกชันฐานข้อมูล Firebase (Firestore) แยกเป็นเอกเทศ
        await addDoc(collection(db, "checkins"), {
            session_id: sessionDocRef ? sessionDocRef.id : "anonymous_session",
            location_id: locId,
            location_name: locName,
            timestamp: new Date().toISOString(),
            checkin_lat: currentLat,
            checkin_lng: currentLng
        });

        // จำเก็บค่าไว้ในเซสชันหน้านั้นถาวร เพื่อไม่ให้ผู้ใช้กดยิงซ้ำไปที่คอลเลกชันเดิมได้อีก
        checkedInPlaces.add(locId);
        checkInBtn.innerText = "🎉 เช็คอินสำเร็จแล้ว!";
        
    } catch (error) {
        console.error("Firebase Store Checkin Error: ", error);
        checkInBtn.innerText = "❌ เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
        checkInBtn.disabled = false;
    }
});

// เปิดใช้งานองค์ประกอบ UI ระบบนำทางทั้งหมดเมื่อกดยืนยันปุ่มเริ่มต้น
document.getElementById('startBtn').addEventListener('click', async () => {
    
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('compassWrap')?.classList.add('active');
    document.getElementById('radarWrap')?.classList.add('active');
    document.getElementById('distanceDisplay')?.classList.add('active');
    document.getElementById('progressWrap')?.classList.add('active');

    function handleOrientation(event) {
        let heading = event.webkitCompassHeading || Math.abs(event.alpha - 360);
        if (heading) {
            currentHeading = heading;
            updateArrow();
        }
    }

    try {
        if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
            const permissionState = await DeviceOrientationEvent.requestPermission();
            if (permissionState === 'granted') {
                window.addEventListener('deviceorientation', handleOrientation);
            }
        } else {
            window.addEventListener('deviceorientationabsolute', handleOrientation) || 
            window.addEventListener('deviceorientation', handleOrientation);
        }
    } catch (error) {
        console.warn("ไม่สามารถตรวจจับฮาร์ดแวร์เข็มทิศได้เนื่องจากข้อจำกัดโปรโตคอล");
    }

    startTracking();
});

fetchLocations();
