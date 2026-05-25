// Import Firebase Functions 
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getFirestore, collection, addDoc, updateDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

// Firebase Config
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
const SHEET_ID = '1W2Yj2aR6dsv0GHOIYwIPA-B9d9RAN9jOgKoDAXkbb70'; 
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

let locations = [];
let announcedPlaces = new Set(); // สำหรับจัดการการอ่านเสียง (ลบได้เมื่อห่าง 80m)
let visitedPlaces = new Set();   // สำหรับนับความคืบหน้า (จำถาวรในเซสชันนี้)
let watchId = null;

// Firebase Session
let sessionDocRef = null;
let sessionStartTime = null;
let currentLat = null;
let currentLng = null;

// Compass & Navigation
let currentHeading = 0;
let targetLat = null;
let targetLng = null;

// โหลดข้อมูล
function fetchLocations() {
    Papa.parse(CSV_URL, {
        download: true,
        header: true,
        complete: function(results) {
            locations = results.data.filter(loc => loc.lat && loc.lng);
            document.getElementById('status').innerText = `โหลดข้อมูลพร้อมแล้ว ${locations.length} จุด`;
            
            // อัปเดตตัวเลขจำนวนจุดทั้งหมด
            const totalEl = document.getElementById('totalCount');
            if(totalEl) totalEl.innerText = locations.length;
        },
        error: function(err) {
            document.getElementById('status').innerText = 'เกิดข้อผิดพลาดในการโหลดข้อมูล';
        }
    });
}

// คำนวณระยะทาง
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

// คำนวณองศาทิศทาง
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

// หมุนลูกศร
function updateArrow() {
    if (targetLat === null || targetLng === null || currentLat === null || currentLng === null) return;
    const bearing = getBearing(currentLat, currentLng, targetLat, targetLng);
    let arrowAngle = bearing - currentHeading;
    const navArrow = document.getElementById('navArrow');
    if (navArrow) {
        navArrow.style.transform = `rotate(${arrowAngle}deg)`;
    }
}

// ระบบพูดออกเสียง
function speak(text, lang) {
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9; 
    window.speechSynthesis.speak(utterance);
}

// บันทึก Firebase
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
        console.error("Firebase Error: ", e);
    }
}

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

// เริ่มเช็คพิกัด
function startTracking() {
    if (!navigator.geolocation) {
        alert("เบราว์เซอร์ไม่รองรับ GPS");
        return;
    }

    document.getElementById('status').innerText = "กำลังค้นหาตำแหน่ง...";
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
                
                // หาจุดที่ใกล้ที่สุดเสมอ สำหรับชี้ลูกศรและคำนวณระยะทาง
                if (distance < minAbsoluteDistance) {
                    minAbsoluteDistance = distance;
                    absoluteNearestLoc = loc;
                }
                
                // เช็คระยะ 50 เมตรเพื่อเตรียมอ่านออกเสียง
                if (distance <= 50) {
                    if (distance < minDistance) {
                        minDistance = distance;
                        closestLocation = loc;
                    }
                }
                
                // ล้างความจำเสียงเมื่อห่างเกิน 80 เมตร (เพื่อให้กลับมาฟังซ้ำได้)
                if (distance > 80 && announcedPlaces.has(loc.id)) {
                    announcedPlaces.delete(loc.id);
                }
            });

            // อัปเดตลูกศรและตัวเลขระยะทาง
            if (absoluteNearestLoc) {
                targetLat = parseFloat(absoluteNearestLoc.lat);
                targetLng = parseFloat(absoluteNearestLoc.lng);
                updateArrow(); 
                
                const distEl = document.getElementById('distanceValue');
                if (distEl) {
                    if (minAbsoluteDistance >= 1000) {
                        distEl.innerText = (minAbsoluteDistance / 1000).toFixed(2) + " กม.";
                    } else {
                        distEl.innerText = Math.round(minAbsoluteDistance) + " ม.";
                    }
                }
            }

            // จัดการแจ้งเตือนเสียง, พื้นหลังกระพริบ, และนับ Progress
            if (closestLocation && !announcedPlaces.has(closestLocation.id)) {
                
                announcedPlaces.add(closestLocation.id); 
                
                // เพิ่มการนับลงใน Progress แบบถาวร
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
        },
        (error) => {
            document.getElementById('status').innerText = "ไม่สามารถระบุตำแหน่งได้ กรุณาเปิด GPS";
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );
}

// ทำงานเมื่อกดปุ่มเริ่ม
document.getElementById('startBtn').addEventListener('click', async () => {
    
    // ซ่อนปุ่ม และเปิดแสดงองค์ประกอบ UI ทั้งหมด
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

    // ขออนุญาตใช้เข็มทิศ
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
        console.warn("ไม่สามารถใช้งานเข็มทิศได้ หรือไม่ได้รันบน HTTPS");
    }

    startTracking();
});

// เริ่มต้นดึงข้อมูลทันทีเมื่อเปิดหน้าเว็บ
fetchLocations();
