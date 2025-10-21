// utils/crearClientesDePrueba.ts
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { db } from '../firebase/firebaseConfig';
import { todayInTZ } from '../utils/timezone';

// ————————————————————————————————————————
// CONFIG
// ————————————————————————————————————————
const DEFAULT_TZ = 'America/Sao_Paulo';
const COUNT = 80; // número de clientes a crear
const INSERT_PRESTAMO_EN_CAJA = true; // para que el desembolso aparezca en Caja/Cerrar Día

// Rangos de montos/ cuotas aleatorios
const MONTO_MIN = 300;
const MONTO_MAX = 3000;
const CUOTA_MIN = 20;
const CUOTA_MAX = 120;

// ————————————————————————————————————————
// Helpers
// ————————————————————————————————————————
const nombres = [
  'Carlos', 'María', 'Pedro', 'Luisa', 'Ana', 'Jose', 'Miguel', 'Sofía',
  'Lucía', 'Andrés', 'Juliana', 'Felipe', 'Camila', 'Javier', 'Valentina',
  'Mateo', 'Daniela', 'Fernanda', 'Gonzalo', 'Patricia', 'Evelin', 'Diana',
  'Rafael', 'Claudia', 'Hernán', 'Iván', 'Beatriz', 'Nicolás', 'Marcos',
  'Sara', 'Esteban', 'Carolina', 'Elena', 'Ricardo', 'Fabián', 'Adriana',
];

const apellidos = [
  'Pérez', 'Gómez', 'Rodríguez', 'Díaz', 'Fernández', 'López', 'Martínez',
  'Muñoz', 'Romero', 'Alvarez', 'Gutiérrez', 'Santos', 'Silva', 'Ramos',
  'Sánchez', 'Torres', 'Castro', 'Vargas', 'Núñez', 'Molina', 'Ortega',
];

const barrios = [
  'Centro', 'San Martín', 'La Floresta', 'Los Rosales', 'El Prado', 'San José',
  'Villa del Sol', 'Santa Rosa', 'Palmas', 'Jardines', 'La Esperanza',
];

const calles = [
  'Av. Bolívar', 'Calle 10', 'Calle 22', 'Av. Libertad', 'Calle 7', 'Calle 15',
  'Carrera 3', 'Carrera 18', 'Av. Principal', 'Calle 5', 'Calle 30',
];

const ciudades = [
  'São Paulo', 'Campinas', 'Santos', 'Ribeirão Preto', 'Sorocaba', 'Diadema',
];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randMoney(min: number, max: number) {
  const v = randInt(min, max);
  return Math.round(v * 100) / 100;
}
function phoneBR() {
  // +55 11 9XXXX-XXXX
  const ddd = randInt(11, 19);
  const p1 = randInt(90000, 99999);
  const p2 = randInt(1000, 9999);
  return `+55 ${ddd} ${p1}-${p2}`;
}
function cedulaFake() {
  return String(randInt(1_000_000, 99_999_999));
}

/** crea between 0 y 3 abonos aleatorios “pequeños” previos al día actual */
function buildAbonos(valorCuota: number, tz: string) {
  const n = randInt(0, 3);
  const ab: Array<{ monto: number; operationalDate: string; tz: string }> = [];
  const hoy = todayInTZ(tz);

  for (let i = 0; i < n; i++) {
    const delta = randInt(1, 5 + i); // algunos días atrás
    const d = new Date(hoy + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - delta);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const op = `${y}-${m}-${dd}`;
    const monto = Math.max(5, Math.round((valorCuota * Math.random()) * 100) / 100);
    ab.push({ monto, operationalDate: op, tz });
  }
  return ab.sort((a, b) => (a.operationalDate < b.operationalDate ? -1 : 1));
}

// ————————————————————————————————————————
// Script principal
// ————————————————————————————————————————
export async function crearClientesDePrueba(admin: string, tenantId: string, count = COUNT) {
  const tz = DEFAULT_TZ;
  const hoy = todayInTZ(tz);

  for (let i = 0; i < count; i++) {
    // ——— Cliente fake
    const nombre = `${rand(nombres)} ${rand(apellidos)}`;
    const alias = nombre.split(' ')[0];
    const telefono = phoneBR();
    const direccion1 = `${rand(calles)} #${randInt(1, 999)}`;
    const direccion2 = `Barrio ${rand(barrios)}`;
    const ciudad = rand(ciudades);
    const cedula = cedulaFake();

    const clienteRef = await addDoc(collection(db, 'clientes'), {
      // Identidad / contacto
      nombre,
      alias,
      telefono1: telefono,
      telefono2: '',
      cedula,
      direccion1,
      direccion2,
      barrio: direccion2,
      ciudad,

      // Control
      admin,               // 👈 dueño lógico
      tenantId,            // 👈 multi-tenant (si no usas, igual no estorba)
      creadoPor: admin,
      creadoEn: serverTimestamp(),
      createdAtMs: Date.now(),

      // Disponibilidad (este cliente tiene préstamo activo recién creado)
      disponible: false,
      tienePrestamoActivo: true,
      statusCliente: 'con_prestamo', // por si tu pantalla de disponibles usa este campo

      // Campos auxiliares
      tz,
      updatedAt: serverTimestamp(),
    });

    const clienteId = clienteRef.id;

    // ——— Préstamo activo
    const totalPrestamo = randMoney(MONTO_MIN, MONTO_MAX);
    const valorCuota = randMoney(CUOTA_MIN, CUOTA_MAX);
    const modalidad = 'Diaria';
    const abonos = buildAbonos(valorCuota, tz);
    const abonado = abonos.reduce((s, a) => s + a.monto, 0);
    const restante = Math.max(0, Math.round((totalPrestamo - abonado) * 100) / 100);

    const prestamoRef = await addDoc(
      collection(db, 'clientes', clienteId, 'prestamos'),
      {
        // Core
        concepto: nombre, // lo presentas como “Nombre del cliente” en la Home
        clienteId,
        creadoPor: admin,
        creadoEn: serverTimestamp(),
        createdAtMs: Date.now(),

        // Monto
        montoTotal: totalPrestamo,
        totalPrestamo,
        valorCuota,
        restante,
        modalidad,

        // Estado
        status: 'activo',
        fechaInicio: hoy,
        tz,

        // Denormalizados (para HomeScreen sin mergear con /clientes)
        clienteAlias: alias,
        clienteDireccion1: direccion1,
        clienteDireccion2: direccion2,
        clienteTelefono1: telefono,

        // Otros (por compat)
        diasHabiles: [1, 2, 3, 4, 5, 6], // lunes-sábado
        feriados: [],
        pausas: [],
        modoAtraso: 'porPresencia',
        permitirAdelantar: true,

        // Abonos simples legacy (para que tu Home muestre “visitado hoy” si cae el caso)
        abonos,
      }
    );

    // ——— CajaDiaria: registrar el desembolso como “prestamo” (para caja/cierre)
    if (INSERT_PRESTAMO_EN_CAJA) {
      await addDoc(collection(db, 'cajaDiaria'), {
        tipo: 'prestamo',
        admin,              // 👈 IMPORTANTÍSIMO para que los KPIs sumen a tu usuario
        tenantId,
        rutaId: null,       // si usas rutas, puedes poner una al azar
        operationalDate: hoy,
        tz,
        monto: totalPrestamo,
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
        source: 'demo',

        // vinculación informativa
        clienteId,
        prestamoId: prestamoRef.id,
        clienteNombre: nombre,
      });
    }

    // (opcional) podríamos simular un gasto_cobrador, pero por ahora no
  }
}
