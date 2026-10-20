

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
static char g_key[32];   

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


const double kReverseAccel = 14;
const double kReverseTop   = 12;
const double kGrassGrip    = 4;


const double kWetGrip      = 0.68;
const double kWetBrake     = 0.75;
const double kWetAccel     = 0.92;

inline double absd(double v) { return v < 0 ? -v : v; }
inline double mind(double a, double b) { return a < b ? a : b; }
inline double maxd(double a, double b) { return a > b ? a : b; }
inline double sgn(double v) { return (v > 0) - (v < 0); }
inline int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }



struct CarSpec {
    double top, accel;          
    double nitro_top, nitro_accel, nitro_burn;   
    double brake;
    double steer, drift_steer;   
    double grip, drift_grip;
};


const CarSpec kModels[] = {
    
    {  40,  25,    55,   38,   0.30, 36,   2.40, 1.75,  11.0, 1.4 },   
    {  43,  27,    58,   40,   0.30, 38,   2.45, 1.75,  12.0, 1.4 },   
    {  42,  28,    56,   40,   0.26, 37,   2.75, 2.00,  10.5, 1.0 },   
    {  47,  31,    63,   44,   0.32, 41,   2.35, 1.70,  12.5, 1.5 },   
};
const int kModelCount = sizeof(kModels) / sizeof(kModels[0]);
const int kMaxLevel = 3;

 
struct Spoiler { double downforce, drag; };
const Spoiler kSpoilers[] = { {0, 0}, {0.06, 0.003}, {0.14, 0.012}, {0.20, 0.022} };


struct Tune {
    double top, accel, nitro_top, nitro_accel, nitro_burn;
    double brake, steer, drift_steer, grip, drift_grip, grass_grip;
    double wet_grip, wet_brake, downforce;
};
Tune tune;

void build_tune(int model, int engine, int tires, int brakes, int spoiler)
{
    const CarSpec &m = kModels[clampi(model, 0, kModelCount - 1)];
    const Spoiler &sp = kSpoilers[clampi(spoiler, 0, 3)];
    engine = clampi(engine, 0, kMaxLevel);
    tires  = clampi(tires, 0, kMaxLevel);
    brakes = clampi(brakes, 0, kMaxLevel);

    Tune &t = tune;
    t.top         = m.top * (1 + 0.05 * engine) * (1 - sp.drag);
    t.nitro_top   = m.nitro_top * (1 + 0.04 * engine) * (1 - sp.drag);
    t.accel       = m.accel * (1 + 0.10 * engine);
    t.nitro_accel = m.nitro_accel * (1 + 0.06 * engine);
    t.nitro_burn  = m.nitro_burn;
    t.brake       = m.brake * (1 + 0.12 * brakes);
    t.wet_brake   = kWetBrake + 0.05 * brakes;
    t.steer       = m.steer;
    t.drift_steer = m.drift_steer;
    t.grip        = m.grip * (1 + 0.08 * tires);
    t.drift_grip  = m.drift_grip * (1 + 0.05 * tires);
    t.grass_grip  = kGrassGrip * (1 + 0.10 * tires);
    t.wet_grip    = kWetGrip + 0.06 * tires;
    t.downforce   = sp.downforce;
}

}  

WASM_EXPORT(model_count) int model_count() { return kModelCount; }


WASM_EXPORT(set_setup) void set_setup(int model, int engine, int tires, int brakes, int spoiler)
{
    build_tune(model, engine, tires, brakes, spoiler);
}


WASM_EXPORT(setup_value) double setup_value(int which)
{
    switch (which) {
    case 0: return tune.top;
    case 1: return tune.accel;
    case 2: return tune.grip * (1 + tune.downforce * 0.5);
    case 3: return tune.brake;
    case 4: return tune.steer;
    case 5: return tune.nitro_top;
    }
    return 0;
}

WASM_EXPORT(drive) void drive()
{
    Car &c = car;
    if (tune.top == 0)
        build_tune(0, 0, 0, 0, 0);   
    const double dt = c.dt;
    const bool locked = c.locked != 0;
    const bool grass  = c.grass != 0;
    const bool wet    = c.wet != 0;
    const double dmg  = c.damage;   

  
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
        c.nitro = maxd(0, c.nitro - dt * tune.nitro_burn);

    double top = boosting ? tune.nitro_top : tune.top;
    if (grass) top *= 0.5;
    top *= 1 - 0.18 * dmg;

    if (locked) {
        fwd = side = 0;
    } else {
        if (gas || boosting) {
            double a = boosting ? tune.nitro_accel : tune.accel;
            if (wet) a *= kWetAccel;
            a *= 1 - 0.15 * dmg;
            
            fwd += a * maxd(0.15, 1 - maxd(0, fwd) / top) * dt;
        }
        if (fwd > top)
            fwd -= (fwd - top) * 2 * dt;

        if (brake) {
            if (fwd > 0.5)
                fwd -= tune.brake * (wet ? tune.wet_brake : 1) * dt;
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


    double yaw = c.steer * tune.steer * mind(1, speed / 8) / (1 + speed / 28);
    if (drifting) yaw *= tune.drift_steer;
    if (fwd < 0)  yaw = -yaw;
    c.angle -= yaw * dt;


    double grip = drifting ? tune.drift_grip : (grass ? tune.grass_grip : tune.grip);
    if (wet) grip *= tune.wet_grip;
    
    if (!drifting)
        grip *= 1 + tune.downforce * mind(1, speed / tune.top);
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
