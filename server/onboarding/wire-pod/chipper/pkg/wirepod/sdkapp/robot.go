package sdkapp

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/digital-dream-labs/hugh/grpc/client"
	"github.com/fforchino/vector-go-sdk/pkg/vector"
	"github.com/fforchino/vector-go-sdk/pkg/vectorpb"
	"github.com/kercre123/wire-pod/chipper/pkg/logger"
	"github.com/kercre123/wire-pod/chipper/pkg/vars"
)

var robots []Robot
var timerStopIndexes []int
var inhibitCreation bool

type CubeState struct {
	Connected    bool    `json:"connected"`
	ObjectId     uint32  `json:"object_id"`
	FactoryId    string  `json:"factory_id"`
	IsMoving     bool    `json:"is_moving"`
	UpAxis       int32   `json:"up_axis"`
	LastTapped   uint32  `json:"last_tapped"`
	BatteryLevel int32   `json:"battery_level"`
	BatteryVolts float32 `json:"battery_volts"`
	// Cube pose (from RobotObservedObject)
	CubeX  float32 `json:"cube_x"`
	CubeY  float32 `json:"cube_y"`
	CubeZ  float32 `json:"cube_z"`
	CubeQ0 float32 `json:"cube_q0"`
	CubeQ1 float32 `json:"cube_q1"`
	CubeQ2 float32 `json:"cube_q2"`
	CubeQ3 float32 `json:"cube_q3"`
	// Robot pose (from RobotState)
	RobotX        float32 `json:"robot_x"`
	RobotY        float32 `json:"robot_y"`
	RobotZ        float32 `json:"robot_z"`
	RobotQ0       float32 `json:"robot_q0"`
	RobotQ1       float32 `json:"robot_q1"`
	RobotQ2       float32 `json:"robot_q2"`
	RobotQ3       float32 `json:"robot_q3"`
	RobotAngleRad float32 `json:"robot_angle_rad"`
	HeadAngleRad  float32 `json:"head_angle_rad"`
	LiftHeightMm  float32 `json:"lift_height_mm"`
	// Charger pose (from RobotObservedObject with ObjectType_CHARGER_BASIC)
	ChargerX       float32 `json:"charger_x"`
	ChargerY       float32 `json:"charger_y"`
	ChargerZ       float32 `json:"charger_z"`
	ChargerQ0      float32 `json:"charger_q0"`
	ChargerQ1      float32 `json:"charger_q1"`
	ChargerQ2      float32 `json:"charger_q2"`
	ChargerQ3      float32 `json:"charger_q3"`
	ChargerVisible bool    `json:"charger_visible"`
}

// FaceDetection holds data for an observed face with landmarks
type FaceDetection struct {
	FaceId           int32      `json:"face_id"`
	Name             string     `json:"name"`
	Expression       string     `json:"expression"`
	ExpressionValues []uint32   `json:"expression_values"` // histogram sums to 100
	ImgRect          [4]float32 `json:"img_rect"`          // x, y, width, height in camera pixels
	LeftEye          [][2]float32 `json:"left_eye"`
	RightEye         [][2]float32 `json:"right_eye"`
	Nose             [][2]float32 `json:"nose"`
	Mouth            [][2]float32 `json:"mouth"`
	PoseX            float32    `json:"pose_x"`
	PoseY            float32    `json:"pose_y"`
	PoseZ            float32    `json:"pose_z"`
}

// SensorState holds full robot telemetry from EventStream
type SensorState struct {
	// Pose
	RobotX        float32 `json:"robot_x"`
	RobotY        float32 `json:"robot_y"`
	RobotZ        float32 `json:"robot_z"`
	RobotQ0       float32 `json:"robot_q0"`
	RobotQ1       float32 `json:"robot_q1"`
	RobotQ2       float32 `json:"robot_q2"`
	RobotQ3       float32 `json:"robot_q3"`
	RobotAngleRad float32 `json:"robot_angle_rad"`
	PosePitchRad  float32 `json:"pose_pitch_rad"`
	HeadAngleRad  float32 `json:"head_angle_rad"`
	LiftHeightMm  float32 `json:"lift_height_mm"`
	// Wheels
	LeftWheelSpeedMmps  float32 `json:"left_wheel_speed_mmps"`
	RightWheelSpeedMmps float32 `json:"right_wheel_speed_mmps"`
	// IMU
	AccelX float32 `json:"accel_x"`
	AccelY float32 `json:"accel_y"`
	AccelZ float32 `json:"accel_z"`
	GyroX  float32 `json:"gyro_x"`
	GyroY  float32 `json:"gyro_y"`
	GyroZ  float32 `json:"gyro_z"`
	// Proximity (ToF)
	ProxDistanceMm   uint32  `json:"prox_distance_mm"`
	ProxSignalQual   float32 `json:"prox_signal_quality"`
	ProxFoundObject  bool    `json:"prox_found_object"`
	ProxLiftInFov    bool    `json:"prox_lift_in_fov"`
	ProxUnobstructed bool    `json:"prox_unobstructed"`
	// Touch
	TouchRawValue  uint32 `json:"touch_raw_value"`
	IsBeingTouched bool   `json:"is_being_touched"`
	// Status flags (from bitmask)
	IsOnCharger     bool `json:"is_on_charger"`
	IsCharging      bool `json:"is_charging"`
	IsMoving        bool `json:"is_moving"`
	IsPickedUp      bool `json:"is_picked_up"`
	IsCliffDetect   bool `json:"is_cliff_detected"`
	IsBeingHeld     bool `json:"is_being_held"`
	IsAnimating     bool `json:"is_animating"`
	IsPathing       bool `json:"is_pathing"`
	IsFalling       bool `json:"is_falling"`
	AreWheelsMoving bool `json:"are_wheels_moving"`
	IsButtonPress   bool `json:"is_button_pressed"`
	IsCarrying      bool `json:"is_carrying_block"`
	IsCalm          bool `json:"is_calm_power_mode"`
	// Stimulation (emotion)
	StimValue float32 `json:"stim_value"`
	// Face (latest observed — backward compat)
	FaceId         int32  `json:"face_id"`
	FaceName       string `json:"face_name"`
	FaceExpression string `json:"face_expression"`
	// Faces with full detection data (landmarks, bounding box, expression histogram)
	Faces []FaceDetection `json:"faces"`
	// Charger
	ChargerX       float32 `json:"charger_x"`
	ChargerY       float32 `json:"charger_y"`
	ChargerZ       float32 `json:"charger_z"`
	ChargerVisible bool    `json:"charger_visible"`
	chargerTTL     int     // ticks until charger_visible resets (not exported)
	// Cube (from object events)
	CubeX       float32 `json:"cube_x"`
	CubeY       float32 `json:"cube_y"`
	CubeZ       float32 `json:"cube_z"`
	CubeVisible bool    `json:"cube_visible"`
	cubeTTL     int     // ticks until cube_visible resets (not exported)
	// Timestamp
	Timestamp int64 `json:"timestamp"`
}

// NavMapLeaf is a single leaf node from the quadtree, in world coordinates
type NavMapLeaf struct {
	X       float32 `json:"x"`       // center X in mm (world coords)
	Y       float32 `json:"y"`       // center Y in mm (world coords)
	Size    float32 `json:"sz"`      // width/height in mm
	Content int     `json:"c"`       // NavNodeContentType (0-9)
}

// NavMapGrid is the nav map data for JSON
type NavMapGrid struct {
	OriginId  uint32       `json:"origin_id"`
	CenterX   float32      `json:"center_x"`
	CenterY   float32      `json:"center_y"`
	SizeMm    float32      `json:"size_mm"`
	Leaves    []NavMapLeaf `json:"leaves"`    // leaf nodes in world coords
	Timestamp int64        `json:"timestamp"`
}

// EventLogEntry is a timestamped event for the event console
type EventLogEntry struct {
	Time    int64  `json:"time"`
	Type    string `json:"type"`
	Message string `json:"message"`
}

type Robot struct {
	ESN               string
	GUID              string
	Target            string
	Vector            *vector.Vector
	BcAssumption      bool
	CamStreaming      bool
	EventStreamClient vectorpb.ExternalInterface_EventStreamClient
	EventsStreaming   bool
	StimState         float32
	ConnTimer         int32
	Ctx               context.Context
	CubeStreaming     bool
	CubeStreamClient  vectorpb.ExternalInterface_EventStreamClient
	Cube              CubeState
	// Sensor dashboard
	SensorStreaming bool
	Sensors         SensorState
	NavMapStreaming bool
	NavMap          NavMapGrid
	EventLog        []EventLogEntry
	EventLogMu      sync.Mutex
}

func newRobot(serial string) (Robot, int, error) {
	inhibitCreation = true
	var RobotObj Robot

	// generate context
	RobotObj.Ctx = context.Background()

	// find robot info in BotInfo
	matched := false
	for _, robot := range vars.BotInfo.Robots {
		if strings.EqualFold(serial, robot.Esn) {
			RobotObj.ESN = strings.TrimSpace(strings.ToLower(serial))
			RobotObj.Target = robot.IPAddress + ":443"
			matched = true
			if robot.GUID == "" {
				robot.GUID = vars.BotInfo.GlobalGUID
				RobotObj.GUID = vars.BotInfo.GlobalGUID
			} else {
				RobotObj.GUID = robot.GUID
			}
			logger.Println("Connecting to " + serial + " with GUID " + RobotObj.GUID)
		}
	}
	if !matched {
		inhibitCreation = false
		return RobotObj, 0, fmt.Errorf("error: robot not found in SDK info file")
	}

	// create Vector instance
	var err error
	RobotObj.Vector, err = vector.New(
		vector.WithTarget(RobotObj.Target),
		vector.WithSerialNo(RobotObj.ESN),
		vector.WithToken(RobotObj.GUID),
	)
	if err != nil {
		inhibitCreation = false
		return RobotObj, 0, err
	}

	// connection check
	_, err = RobotObj.Vector.Conn.BatteryState(context.Background(), &vectorpb.BatteryStateRequest{})
	if err != nil {
		inhibitCreation = false
		return RobotObj, 0, err
	}

	// create client for event stream
	RobotObj.EventStreamClient, err = RobotObj.Vector.Conn.EventStream(
		RobotObj.Ctx,
		&vectorpb.EventRequest{
			ListType: &vectorpb.EventRequest_WhiteList{
				WhiteList: &vectorpb.FilterList{
					// this will be used only for stimulation graph for now
					List: []string{"stimulation_info"},
				},
			},
		},
	)
	if err != nil {
		inhibitCreation = false
		return RobotObj, 0, err
	}
	RobotObj.CamStreaming = false
	RobotObj.EventsStreaming = false

	// we have confirmed robot connection works, append to list of bots
	robots = append(robots, RobotObj)
	robotIndex := len(robots) - 1

	// begin inactivity timer
	go connTimer(robotIndex)

	inhibitCreation = false
	return RobotObj, robotIndex, nil
}

func getRobot(serial string) (Robot, int, error) {
	// look in robot list
	for {
		if !inhibitCreation {
			break
		}
		time.Sleep(time.Second / 2)
	}
	for index, robot := range robots {
		if strings.EqualFold(serial, robot.ESN) {
			return robot, index, nil
		}
	}
	return newRobot(serial)
}

// if connection is inactive for more than 5 minutes, remove robot
// run this as a goroutine
func connTimer(ind int) {
	// Check if the index is in the list
	if len(robots) <= ind {
		return
	}

	robots[ind].ConnTimer = 0
	for {
		time.Sleep(time.Second)
		// check if timer needs to be stopped
		for _, num := range timerStopIndexes {
			if num == ind {
				logger.Println("Conn timer for robot index " + strconv.Itoa(ind) + " stopping")
				var newIndexes []int
				for _, num := range timerStopIndexes {
					if num != ind {
						newIndexes = append(newIndexes, num)
					}
				}
				timerStopIndexes = newIndexes
				return
			}
		}
		if robots[ind].ConnTimer >= 300 {
			logger.Println("Closing SDK connection for " + robots[ind].ESN + ", source: connTimer")
			removeRobot(robots[ind].ESN, "connTimer")
			return
		}  
		robots[ind].ConnTimer = robots[ind].ConnTimer + 1
	}
}

func removeRobot(serial, source string) {
	inhibitCreation = true
	var newRobots []Robot
	for ind, robot := range robots {
		if !strings.EqualFold(serial, robot.ESN) {
			newRobots = append(newRobots, robot)
		} else {
			if source == "server" {
				timerStopIndexes = append(timerStopIndexes, ind)
			}
			robots[ind].CamStreaming = false
			robots[ind].EventsStreaming = false
			robots[ind].CubeStreaming = false
			robots[ind].SensorStreaming = false
			robots[ind].NavMapStreaming = false
			robots[ind].BcAssumption = false
			// give time for all of that to stop
			time.Sleep(time.Second * 3)
		}
	}
	robots = newRobots
	inhibitCreation = false
}

func NewWP(serial string, useGlobal bool) (*vector.Vector, error) {
	var target, guid string
	if serial == "" {
		return nil, fmt.Errorf("serial string missing")
	}
	matched := false
	for _, robot := range vars.BotInfo.Robots {
		if strings.EqualFold(serial, robot.Esn) {
			matched = true
			target = robot.IPAddress + ":443"
			guid = robot.GUID
			break
		}
	}
	if !matched {
		logger.Println("serial did not match any bot in bot json")
		return nil, errors.New("serial did not match any bot in bot json")
	}
	c, err := client.New(
		client.WithTarget(target),
		client.WithInsecureSkipVerify(),
	)
	if err != nil {
		return nil, err
	}
	if err := c.Connect(); err != nil {
		return nil, err
	}
	return vector.New(
		vector.WithTarget(target),
		vector.WithSerialNo(serial),
		vector.WithToken(guid),
	)
}
