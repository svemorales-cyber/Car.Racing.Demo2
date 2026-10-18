

extern "C" {
__attribute__((import_module("env"), import_name("sin"))) double js_sin(double);
__attribute__((import_module("env"), import_name("cos"))) double js_cos(double);
__attribute__((import_module("env"), import_name("exp"))) double js_exp(double);
}

#define WASM_EXPORT(name) extern "C" __attribute__((export_name(#name)))

enum Action { GAS, BRAKE, LEFT, RIGHT, DRIFT, BOOST, NUM_ACTIONS };
enum Command { NO_CMD, CMD_CAMERA, CMD_MUTE, CMD_RESPAWN, CMD_PAUSE, CMD_START };

struct KeyBind {
    const char *code;
    int id;
};


static const KeyBind kActionKeys[] = {
    {"KeyW", GAS},       {"ArrowUp", GAS},
    {"KeyS", BRAKE},     {"ArrowDown", BRAKE},
    {"KeyA", LEFT},      {"ArrowLeft", LEFT},
    {"KeyD", RIGHT},     {"ArrowRight", RIGHT},
    {"Space", DRIFT},
    {"ShiftLeft", BOOST}, {"ShiftRight", BOOST}, {"KeyN", BOOST},
};

static const KeyBind kCommandKeys[] = {
    {"KeyC", CMD_CAMERA},
    {"KeyM", CMD_MUTE},
    {"KeyR", CMD_RESPAWN},
    {"Escape", CMD_PAUSE}, {"KeyP", CMD_PAUSE},
    {"Enter", CMD_START},  {"NumpadEnter", CMD_START},
};

static bool g_held[NUM_ACTIONS];
static char g_key[32];   // JS copies e.code in here before on_key()

static bool key_is(const char *code, int len)
{
    int i = 0;
    for (; i < len; i++) {
        if (code[i] != g_key[i])
            return false;
    }
    return code[i] == '\0';
}

WASM_EXPORT(key_buffer) char *key_buffer() { return g_key; }


WASM_EXPORT(on_key) int on_key(int len, int down, int repeat)
{
    for (const KeyBind &k : kActionKeys) {
        if (key_is(k.code, len)) {
            g_held[k.id] = down;
            return 0;
        }
    }
    for (const KeyBind &k : kCommandKeys) {
        if (key_is(k.code, len))
            return (down && !repeat) ? k.id : NO_CMD;
    }
    return -1;
}


WASM_EXPORT(set_action) void set_action(int a, int down)
{
    if (a >= 0 && a < NUM_ACTIONS)
        g_held[a] = down;
}

WASM_EXPORT(action_down) int action_down(int a)
{
    return a >= 0 && a < NUM_ACTIONS && g_held[a];
}


WASM_EXPORT(release_all) void release_all()
{
    for (bool &h : g_held)
        h = false;
}


// ---- handling ----


struct Car {
 
    double dt, locked, finished, grass, wet, damage;
   
    double x, z, angle, vx, vz, steer, nitro, was_boosting;
    
    double fwd_speed, side_speed, yaw, boosting, drifting;
    double gas, brake, nitro_started;
    double fx, fz, rx, rz;
};

static Car car;

WASM_EXPORT(car_state) Car *car_state() { return &car; }

namespace {


const double kTopSpeed     = 40;
const double kNitroTop     = 55;
const double kAccel        = 25;
const double kNitroAccel   = 38;
const double kBrake        = 36;
const double kReverseAccel = 14;
const double kReverseTop   = 12;
const double kNitroBurn    = 0.3;    

const double kSteer        = 2.4;
const double kDriftSteer   = 1.75;   
const double kGrip         = 11;
const double kGrassGrip    = 4;
const double kDriftGrip    = 1.4;


const double kWetGrip      = 0.68;
const double kWetBrake     = 0.75;
const double kWetAccel     = 0.92;

inline double absd(double v) { return v < 0 ? -v : v; }
inline double mind(double a, double b) { return a < b ? a : b; }
inline double maxd(double a, double b) { return a > b ? a : b; }
inline double sgn(double v) { return (v > 0) - (v < 0); }

}  

WASM_EXPORT(drive) void drive()
{
    Car &c = car;
    const double dt = c.dt;
    const bool locked = c.locked != 0;
    const bool grass  = c.grass != 0;
    const bool wet    = c.wet != 0;
    const double dmg  = c.damage;   // 0..1

    
    bool gas = false, brake = true, handbrake = false, nitro = false;
    int steer_in = 0;
    if (!c.finished) {
        gas       = g_held[GAS];
        brake     = g_held[BRAKE];
        handbrake = g_held[DRIFT];
        nitro     = g_held[BOOST];
        steer_in  = int(g_held[RIGHT]) - int(g_held[LEFT]);
    }

   
    double want = steer_in;
    if (dmg > 0.5)
        want += (dmg - 0.5) * 0.25;
    c.steer += (want - c.steer) * mind(1.0, dt * (steer_in ? 7 : 10));

    double sa = js_sin(c.angle), ca = js_cos(c.angle);
    double fx = sa, fz = ca;        
    double rx = -ca, rz = sa;       
    double fwd  = c.vx * fx + c.vz * fz;
    double side = c.vx * rx + c.vz * rz;

    bool boosting = !locked && nitro && c.nitro > 0 && fwd > -1;
    c.nitro_started = boosting && !c.was_boosting;
    c.was_boosting = boosting;
    if (boosting)
        c.nitro = maxd(0, c.nitro - dt * kNitroBurn);

    double top = boosting ? kNitroTop : kTopSpeed;
    if (grass) top *= 0.5;
    top *= 1 - 0.18 * dmg;

    if (locked) {
        fwd = side = 0;
    } else {
        if (gas || boosting) {
            double a = boosting ? kNitroAccel : kAccel;
            if (wet) a *= kWetAccel;
            a *= 1 - 0.15 * dmg;
            // pulls hard from low speed, fades out near top speed
            fwd += a * maxd(0.15, 1 - maxd(0, fwd) / top) * dt;
        }
        if (fwd > top)
            fwd -= (fwd - top) * 2 * dt;

        if (brake) {
            if (fwd > 0.5)
                fwd -= kBrake * (wet ? kWetBrake : 1) * dt;
            else
                fwd = maxd(-kReverseTop, fwd - kReverseAccel * dt);   
        }

        
        fwd -= sgn(fwd) * (1 + absd(fwd) * 0.035 + (grass ? 5 : 0)) * dt;
        if (!gas && !brake && absd(fwd) < 0.4)
            fwd = 0;
        if (handbrake)
            fwd -= fwd * 0.3 * dt;
    }

    double speed = absd(fwd);
    bool drifting = handbrake && speed > 9;

    
    double yaw = c.steer * kSteer * mind(1, speed / 8) / (1 + speed / 28);
    if (drifting) yaw *= kDriftSteer;
    if (fwd < 0)  yaw = -yaw;
    c.angle -= yaw * dt;


    double grip = drifting ? kDriftGrip : (grass ? kGrassGrip : kGrip);
    if (wet) grip *= kWetGrip;
    side *= js_exp(-grip * dt);

    c.vx = fx * fwd + rx * side;
    c.vz = fz * fwd + rz * side;
    c.x += c.vx * dt;
    c.z += c.vz * dt;

    c.fwd_speed = fwd;
    c.side_speed = side;
    c.yaw = yaw;
    c.boosting = boosting;
    c.drifting = drifting;
    c.gas = gas;
    c.brake = brake;
    c.fx = fx; c.fz = fz;
    c.rx = rx; c.rz = rz;
}
