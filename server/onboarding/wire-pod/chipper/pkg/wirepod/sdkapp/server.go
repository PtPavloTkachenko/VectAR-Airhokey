package sdkapp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/fforchino/vector-go-sdk/pkg/vector"
	"github.com/fforchino/vector-go-sdk/pkg/vectorpb"
	"github.com/kercre123/wire-pod/chipper/pkg/logger"
	"github.com/kercre123/wire-pod/chipper/pkg/scripting"
	"github.com/kercre123/wire-pod/chipper/pkg/vars"
)

var serverFiles string = "./webroot/sdkapp"
var serverStartTime = time.Now()

func SdkapiHandler(w http.ResponseWriter, r *http.Request) {
	// Endpoints that don't require a robot connection
	switch {
	case r.URL.Path == "/api-sdk/server_status":
		type robotEntry struct {
			ESN string `json:"esn"`
			IP  string `json:"ip"`
		}
		var connRobots []robotEntry
		for _, rb := range robots {
			if rb.Vector != nil {
				ip := strings.Split(rb.Target, ":")[0]
				connRobots = append(connRobots, robotEntry{ESN: rb.ESN, IP: ip})
			}
		}
		if connRobots == nil {
			connRobots = []robotEntry{}
		}
		resp := map[string]interface{}{
			"uptime_sec":       int(time.Since(serverStartTime).Seconds()),
			"robots_connected": len(connRobots),
			"robots":           connRobots,
			"platform":         runtime.GOOS + "/" + runtime.GOARCH,
		}
		w.Header().Set("Content-Type", "application/json")
		jsonBytes, _ := json.Marshal(resp)
		w.Write(jsonBytes)
		return
	case r.URL.Path == "/api-sdk/restart_server":
		fmt.Fprint(w, "restarting")
		go func() {
			time.Sleep(500 * time.Millisecond)
			logger.Println("Server restart requested via web UI")
			os.Exit(0)
		}()
		return
	}

	robotObj, robotIndex, err := getRobot(r.FormValue("serial"))
	robot := robotObj.Vector
	ctx := robotObj.Ctx
	if r.URL.Path != "/api-sdk/get_sdk_info" && r.URL.Path != "/api-sdk/debug" {
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		robots[robotIndex].ConnTimer = 0
	}
	switch {
	default:
		http.Error(w, "not found", http.StatusNotFound)
		return
	case r.URL.Path == "/api-sdk/conn_test":
		// getRobot does connection check and will return error if failed
		fmt.Fprint(w, "success")
		return
	case r.URL.Path == "/api-sdk/alexa_sign_in":
		robot.Conn.AlexaOptIn(ctx, &vectorpb.AlexaOptInRequest{
			OptIn: true,
		})
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/alexa_sign_out":
		robot.Conn.AlexaOptIn(ctx, &vectorpb.AlexaOptInRequest{
			OptIn: false,
		})
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/cloud_intent":
		intent := r.FormValue("intent")
		robot.Conn.AppIntent(ctx,
			&vectorpb.AppIntentRequest{
				Intent: intent,
			},
		)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/eye_color":
		eye_color := r.FormValue("color")
		setPresetEyeColor(robotObj, eye_color)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/custom_eye_color":
		hue := r.FormValue("hue")
		sat := r.FormValue("sat")
		setCustomEyeColor(robotObj, hue, sat)
		fmt.Fprintf(w, hue+sat)
		return
	case r.URL.Path == "/api-sdk/volume":
		volume := r.FormValue("volume")
		setSettingSDKintbool(robotObj, "master_volume", volume)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/locale":
		locale := r.FormValue("locale")
		setSettingSDKstring(robotObj, "locale", locale)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/location":
		location := r.FormValue("location")
		setSettingSDKstring(robotObj, "default_location", location)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/timezone":
		timezone := r.FormValue("timezone")
		setSettingSDKstring(robotObj, "time_zone", timezone)
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/get_sdk_info":
		if len(vars.BotInfo.Robots) == 0 {
			http.Error(w, "no bots are authenticated", http.StatusInternalServerError)
			return
		}
		jsonBytes, err := json.Marshal(vars.BotInfo)
		if err != nil {
			fmt.Fprintf(w, "error marshaling json")
			return
		}
		fmt.Fprint(w, string(jsonBytes))
		return
	case r.URL.Path == "/api-sdk/get_sdk_settings":
		i := 0
		for {
			resp, err := robot.Conn.PullJdocs(ctx, &vectorpb.PullJdocsRequest{
				JdocTypes: []vectorpb.JdocType{vectorpb.JdocType_ROBOT_SETTINGS},
			})
			if err != nil {
				w.Write([]byte(err.Error()))
				return
			}
			if strings.Contains(resp.NamedJdocs[0].Doc.JsonDoc, "BStat.ReactedToTriggerWord") {
				time.Sleep(time.Second / 2)
				if i > 3 {
					logger.Println("Bot refuses to return RobotSettings jdoc...")
					logger.Println("Returned Jdoc: ", resp.NamedJdocs[0].Doc.JsonDoc)
					w.Write([]byte("error: bot refuses to return robotsettings"))
					return
				}
				i = i + 1
				continue
			}
			json := resp.NamedJdocs[0].Doc.JsonDoc
			var ajdoc vars.AJdoc
			ajdoc.DocVersion = resp.NamedJdocs[0].Doc.DocVersion
			ajdoc.FmtVersion = resp.NamedJdocs[0].Doc.FmtVersion
			ajdoc.JsonDoc = resp.NamedJdocs[0].Doc.JsonDoc
			vars.AddJdoc("vic:"+robotObj.ESN, "vic.RobotSettings", ajdoc)
			logger.Println("Updating vic.RobotSettings (source: sdkapp)")
			w.WriteHeader(http.StatusOK)
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte(json))
			return
		}

	case r.URL.Path == "/api-sdk/play_sound":
		file, _, err := r.FormFile("sound")
		if err != nil {
			println("Error retrieving the file:", err)
			return
		}
		defer file.Close()

		// Lê o conteúdo do arquivo em um slice de bytes
		pcmFile, err := io.ReadAll(file)
		if err != nil {
			println("Error reading the file:", err)
			return
		}

		var audioChunks [][]byte
		for len(pcmFile) >= 1024 {
			audioChunks = append(audioChunks, pcmFile[:1024])
			pcmFile = pcmFile[1024:]
		}

		var audioClient vectorpb.ExternalInterface_ExternalAudioStreamPlaybackClient
		audioClient, _ = robot.Conn.ExternalAudioStreamPlayback(ctx)
		audioClient.SendMsg(&vectorpb.ExternalAudioStreamRequest{
			AudioRequestType: &vectorpb.ExternalAudioStreamRequest_AudioStreamPrepare{
				AudioStreamPrepare: &vectorpb.ExternalAudioStreamPrepare{
					AudioFrameRate: 8000,
					AudioVolume:    uint32(100),
				},
			},
		})

		for _, chunk := range audioChunks {
			audioClient.SendMsg(&vectorpb.ExternalAudioStreamRequest{
				AudioRequestType: &vectorpb.ExternalAudioStreamRequest_AudioStreamChunk{
					AudioStreamChunk: &vectorpb.ExternalAudioStreamChunk{
						AudioChunkSizeBytes: uint32(len(chunk)),
						AudioChunkSamples:   chunk,
					},
				},
			})
			time.Sleep(time.Millisecond * 60)
		}

		audioClient.SendMsg(&vectorpb.ExternalAudioStreamRequest{
			AudioRequestType: &vectorpb.ExternalAudioStreamRequest_AudioStreamComplete{
				AudioStreamComplete: &vectorpb.ExternalAudioStreamComplete{},
			},
		})

		return

	case r.URL.Path == "/api-sdk/get_battery":
		// Ensure the endpoint times out after 15 seconds
		ctx := r.Context() // Get the request context
		ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()

		resp, err := robot.Conn.BatteryState(ctx, &vectorpb.BatteryStateRequest{})
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		jsonBytes, err := json.Marshal(resp)
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		fmt.Fprint(w, string(jsonBytes))
		return
	case r.URL.Path == "/api-sdk/time_format_12":
		setSettingSDKintbool(robotObj, "clock_24_hour", "false")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/time_format_24":
		setSettingSDKintbool(robotObj, "clock_24_hour", "true")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/temp_c":
		setSettingSDKintbool(robotObj, "temp_is_fahrenheit", "false")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/temp_f":
		setSettingSDKintbool(robotObj, "temp_is_fahrenheit", "true")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/button_hey_vector":
		setSettingSDKintbool(robotObj, "button_wakeword", "0")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/button_alexa":
		setSettingSDKintbool(robotObj, "button_wakeword", "1")
		fmt.Fprintf(w, "done")
		return
	case r.URL.Path == "/api-sdk/assume_behavior_control":
		fmt.Fprintf(w, "success")
		assumeBehaviorControl(robotObj, robotIndex, r.FormValue("priority"))
		return
	case r.URL.Path == "/api-sdk/release_behavior_control":
		robots[robotIndex].BcAssumption = false
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/say_text":
		if len([]rune(r.FormValue("text"))) >= 600 {
			fmt.Fprint(w, "error: text is too long")
		}
		robot.Conn.SayText(
			ctx,
			&vectorpb.SayTextRequest{
				DurationScalar: 1,
				UseVectorVoice: true,
				Text:           r.FormValue("text"),
			},
		)
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/move_wheels":
		lw, _ := strconv.Atoi(r.FormValue("lw"))
		rw, _ := strconv.Atoi(r.FormValue("rw"))
		robot.Conn.DriveWheels(ctx,
			&vectorpb.DriveWheelsRequest{
				LeftWheelMmps:   float32(lw),
				RightWheelMmps:  float32(rw),
				LeftWheelMmps2:  float32(lw),
				RightWheelMmps2: float32(rw),
			},
		)
		fmt.Fprintf(w, "")
		return
	case r.URL.Path == "/api-sdk/move_lift":
		speed, _ := strconv.Atoi(r.FormValue("speed"))
		robot.Conn.MoveLift(
			ctx,
			&vectorpb.MoveLiftRequest{
				SpeedRadPerSec: float32(speed),
			},
		)
		fmt.Fprintf(w, "")
		return
	case r.URL.Path == "/api-sdk/move_head":
		speed, _ := strconv.Atoi(r.FormValue("speed"))
		robot.Conn.MoveHead(
			ctx,
			&vectorpb.MoveHeadRequest{
				SpeedRadPerSec: float32(speed),
			},
		)
		fmt.Fprintf(w, "")
		return
	case r.URL.Path == "/api-sdk/get_faces":
		resp, err := robot.Conn.RequestEnrolledNames(
			ctx,
			&vectorpb.RequestEnrolledNamesRequest{})
		if err != nil {
			fmt.Fprint(w, err.Error())
			return
		}
		bytes, _ := json.Marshal(resp.Faces)
		fmt.Fprint(w, string(bytes))
		return
	case r.URL.Path == "/api-sdk/rename_face":
		id := r.FormValue("id")
		oldname := r.FormValue("oldname")
		newname := r.FormValue("newname")
		idInt, _ := strconv.Atoi(id)
		idInt32 := int32(idInt)
		_, err := robot.Conn.UpdateEnrolledFaceByID(
			ctx,
			&vectorpb.UpdateEnrolledFaceByIDRequest{
				FaceId:  idInt32,
				OldName: oldname,
				NewName: newname,
			})
		if err != nil {
			fmt.Fprint(w, err.Error())
			return
		}
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/delete_face":
		id := r.FormValue("id")
		idInt, _ := strconv.Atoi(id)
		idInt32 := int32(idInt)
		_, err := robot.Conn.EraseEnrolledFaceByID(
			ctx,
			&vectorpb.EraseEnrolledFaceByIDRequest{
				FaceId: idInt32,
			})
		if err != nil {
			fmt.Fprint(w, err.Error())
			return
		}
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/add_face":
		name := r.FormValue("name")
		_, err := robot.Conn.AppIntent(
			ctx,
			&vectorpb.AppIntentRequest{
				Intent: "intent_meet_victor",
				Param:  name,
			},
		)
		if err != nil {
			fmt.Fprint(w, err.Error())
			return
		}
		fmt.Fprintf(w, "success")
		return
	case r.URL.Path == "/api-sdk/mirror_mode":
		enable := r.FormValue("enable")
		if enable == "true" {
			_, err := robot.Conn.EnableMirrorMode(
				ctx,
				&vectorpb.EnableMirrorModeRequest{
					Enable: true,
				},
			)
			if err != nil {
				fmt.Fprint(w, err)
				return
			}
		} else {
			_, err := robot.Conn.EnableMirrorMode(
				ctx,
				&vectorpb.EnableMirrorModeRequest{
					Enable: false,
				},
			)
			if err != nil {
				fmt.Fprint(w, err)
				return
			}
		}
		fmt.Fprint(w, "success")
		return
	case r.URL.Path == "/api-sdk/begin_event_stream":
		// setup websocket
		robots[robotIndex].EventsStreaming = true
		go func() {
			client, err := robot.Conn.EventStream(
				ctx,
				&vectorpb.EventRequest{
					ListType: &vectorpb.EventRequest_WhiteList{
						WhiteList: &vectorpb.FilterList{
							List: []string{"stimulation_info"},
						},
					},
					ConnectionId: "wirepod",
				},
			)
			if err != nil {
				fmt.Fprint(w, err.Error())
			}
			for {
				if robots[robotIndex].EventsStreaming {
					resp, err := client.Recv()
					if err != nil {
						fmt.Fprint(w, err.Error())
						robots[robotIndex].EventsStreaming = false
						return
					}
					stimInfo := resp.Event.GetStimulationInfo()
					stimInfoString := fmt.Sprint(stimInfo)
					if strings.Contains(stimInfoString, "velocity") {
						// velocity in the string means there is a value
						robots[robotIndex].StimState = stimInfo.Value
					}
				} else {
					return
				}
			}
		}()
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/stop_event_stream":
		robots[robotIndex].EventsStreaming = false
		robots[robotIndex].StimState = 0
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/get_stim_status":
		if robots[robotIndex].EventsStreaming {
			fmt.Fprint(w, robots[robotIndex].StimState)
			return
		}
		fmt.Fprint(w, "error: must start event stream")
		return
	case r.URL.Path == "/api-sdk/begin_cam_stream":
		//robots[robotIndex].CamStreaming = true
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/stop_cam_stream":
		robots[robotIndex].CamStreaming = false
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/get_image_ids":
		var photoIds []uint32
		resp, _ := robot.Conn.PhotosInfo(
			ctx,
			&vectorpb.PhotosInfoRequest{},
		)
		for _, photo := range resp.PhotoInfos {
			photoIds = append(photoIds, photo.PhotoId)
		}
		writeBytes, _ := json.Marshal(photoIds)
		w.Write(writeBytes)
		return
	case r.URL.Path == "/api-sdk/get_image":
		id, err := strconv.Atoi(r.FormValue("id"))
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		resp, err := robot.Conn.Photo(
			ctx,
			&vectorpb.PhotoRequest{
				PhotoId: uint32(id),
			},
		)
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		w.Write(resp.Image)
		return
	case r.URL.Path == "/api-sdk/get_image_thumb":
		id, err := strconv.Atoi(r.FormValue("id"))
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		resp, err := robot.Conn.Thumbnail(
			ctx,
			&vectorpb.ThumbnailRequest{
				PhotoId: uint32(id),
			},
		)
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		w.Write(resp.Image)
		return
	case r.URL.Path == "/api-sdk/delete_image":
		id, err := strconv.Atoi(r.FormValue("id"))
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		_, err = robot.Conn.DeletePhoto(
			ctx,
			&vectorpb.DeletePhotoRequest{
				PhotoId: uint32(id),
			},
		)
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/get_robot_stats":
		resp, err := robot.Conn.PullJdocs(ctx,
			&vectorpb.PullJdocsRequest{
				JdocTypes: []vectorpb.JdocType{vectorpb.JdocType_ROBOT_LIFETIME_STATS},
			})
		if err != nil {
			fmt.Fprint(w, "error: "+err.Error())
			return
		}
		w.Write([]byte(resp.GetNamedJdocs()[0].Doc.JsonDoc))
		return
	case r.URL.Path == "/api-sdk/print_robot_info":
		fmt.Fprint(w, robot)
		return
	case r.URL.Path == "/api-sdk/disconnect":
		removeRobot(robotObj.ESN, "server")
		fmt.Fprint(w, "done")
		return
	case r.URL.Path == "/api-sdk/trigger_wake_word":
		robotIP := strings.Split(robotObj.Target, ":")[0]
		consoleURL := fmt.Sprintf("http://%s:8889/consolevarset?key=FakeButtonPressType&value=singlePressDetected", robotIP)

		client := &http.Client{
			Timeout: 10 * time.Second,
		}

		resp, err := client.Get(consoleURL)
		if err != nil {
			http.Error(w, "Failed to trigger wake word: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			http.Error(w, "Consolevars returned error", resp.StatusCode)
			return
		}

		fmt.Fprint(w, "success")
		return
	case r.URL.Path == "/api-sdk/connect_cube":
		resp, err := robot.Conn.ConnectCube(ctx, &vectorpb.ConnectCubeRequest{})
		if err != nil {
			fmt.Fprint(w, `{"error":"`+err.Error()+`"}`)
			return
		}
		robots[robotIndex].Cube.Connected = resp.GetSuccess()
		robots[robotIndex].Cube.ObjectId = resp.GetObjectId()
		robots[robotIndex].Cube.FactoryId = resp.GetFactoryId()
		jsonBytes, _ := json.Marshal(resp)
		fmt.Fprint(w, string(jsonBytes))
		return
	case r.URL.Path == "/api-sdk/disconnect_cube":
		robots[robotIndex].CubeStreaming = false
		time.Sleep(time.Millisecond * 300)
		_, err := robot.Conn.DisconnectCube(ctx, &vectorpb.DisconnectCubeRequest{})
		if err != nil {
			fmt.Fprint(w, `{"error":"`+err.Error()+`"}`)
			return
		}
		robots[robotIndex].Cube = CubeState{}
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/cube_status":
		jsonBytes, _ := json.Marshal(robots[robotIndex].Cube)
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonBytes)
		return
	case r.URL.Path == "/api-sdk/begin_cube_stream":
		robots[robotIndex].CubeStreaming = true
		go func() {
			cubeClient, err := robot.Conn.EventStream(
				ctx,
				&vectorpb.EventRequest{
					ListType: &vectorpb.EventRequest_WhiteList{
						WhiteList: &vectorpb.FilterList{
							List: []string{"object_event", "robot_state", "cube_battery"},
						},
					},
					ConnectionId: "wirepod_cube",
				},
			)
			if err != nil {
				logger.Println("Cube stream error: " + err.Error())
				robots[robotIndex].CubeStreaming = false
				return
			}
			robots[robotIndex].CubeStreamClient = cubeClient
			for {
				if !robots[robotIndex].CubeStreaming {
					return
				}
				resp, err := cubeClient.Recv()
				if err != nil {
					logger.Println("Cube stream recv error: " + err.Error())
					robots[robotIndex].CubeStreaming = false
					return
				}
				evt := resp.GetEvent()
				if evt == nil {
					continue
				}
				// Object events
				if objEvt := evt.GetObjectEvent(); objEvt != nil {
					if cs := objEvt.GetObjectConnectionState(); cs != nil {
						robots[robotIndex].Cube.Connected = cs.GetConnected()
						robots[robotIndex].Cube.ObjectId = cs.GetObjectId()
						robots[robotIndex].Cube.FactoryId = cs.GetFactoryId()
					}
					if obs := objEvt.GetRobotObservedObject(); obs != nil {
						objType := obs.GetObjectType()
						if pose := obs.GetPose(); pose != nil {
							if objType == vectorpb.ObjectType_CHARGER_BASIC {
								robots[robotIndex].Cube.ChargerX = pose.GetX()
								robots[robotIndex].Cube.ChargerY = pose.GetY()
								robots[robotIndex].Cube.ChargerZ = pose.GetZ()
								robots[robotIndex].Cube.ChargerQ0 = pose.GetQ0()
								robots[robotIndex].Cube.ChargerQ1 = pose.GetQ1()
								robots[robotIndex].Cube.ChargerQ2 = pose.GetQ2()
								robots[robotIndex].Cube.ChargerQ3 = pose.GetQ3()
								robots[robotIndex].Cube.ChargerVisible = true
							} else {
								robots[robotIndex].Cube.CubeX = pose.GetX()
								robots[robotIndex].Cube.CubeY = pose.GetY()
								robots[robotIndex].Cube.CubeZ = pose.GetZ()
								robots[robotIndex].Cube.CubeQ0 = pose.GetQ0()
								robots[robotIndex].Cube.CubeQ1 = pose.GetQ1()
								robots[robotIndex].Cube.CubeQ2 = pose.GetQ2()
								robots[robotIndex].Cube.CubeQ3 = pose.GetQ3()
							}
						}
					}
					if moved := objEvt.GetObjectMoved(); moved != nil {
						robots[robotIndex].Cube.IsMoving = true
					}
					if stopped := objEvt.GetObjectStoppedMoving(); stopped != nil {
						robots[robotIndex].Cube.IsMoving = false
					}
					if upAxis := objEvt.GetObjectUpAxisChanged(); upAxis != nil {
						robots[robotIndex].Cube.UpAxis = int32(upAxis.GetUpAxis())
					}
					if tapped := objEvt.GetObjectTapped(); tapped != nil {
						robots[robotIndex].Cube.LastTapped = tapped.GetTimestamp()
					}
				}
				// Robot state
				if rs := evt.GetRobotState(); rs != nil {
					if pose := rs.GetPose(); pose != nil {
						robots[robotIndex].Cube.RobotX = pose.GetX()
						robots[robotIndex].Cube.RobotY = pose.GetY()
						robots[robotIndex].Cube.RobotZ = pose.GetZ()
						robots[robotIndex].Cube.RobotQ0 = pose.GetQ0()
						robots[robotIndex].Cube.RobotQ1 = pose.GetQ1()
						robots[robotIndex].Cube.RobotQ2 = pose.GetQ2()
						robots[robotIndex].Cube.RobotQ3 = pose.GetQ3()
					}
					robots[robotIndex].Cube.RobotAngleRad = rs.GetPoseAngleRad()
					robots[robotIndex].Cube.HeadAngleRad = rs.GetHeadAngleRad()
					robots[robotIndex].Cube.LiftHeightMm = rs.GetLiftHeightMm()
				}
				// Cube battery
				if cb := evt.GetCubeBattery(); cb != nil {
					robots[robotIndex].Cube.BatteryLevel = int32(cb.GetLevel())
					robots[robotIndex].Cube.BatteryVolts = cb.GetBatteryVolts()
					robots[robotIndex].Cube.FactoryId = cb.GetFactoryId()
				}
			}
		}()
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/stop_cube_stream":
		robots[robotIndex].CubeStreaming = false
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/flash_cube":
		_, err := robot.Conn.FlashCubeLights(ctx, &vectorpb.FlashCubeLightsRequest{})
		if err != nil {
			fmt.Fprint(w, `{"error":"`+err.Error()+`"}`)
			return
		}
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/begin_sensor_stream":
		if robots[robotIndex].SensorStreaming {
			fmt.Fprint(w, `{"status":"already_running"}`)
			return
		}
		robots[robotIndex].SensorStreaming = true
		robots[robotIndex].EventLog = make([]EventLogEntry, 0, 200)
		// Enable full face detection (expression, smile, blink, gaze)
		robot.Conn.EnableFaceDetection(ctx, &vectorpb.EnableFaceDetectionRequest{
			Enable:                      true,
			EnableSmileDetection:        true,
			EnableExpressionEstimation:  true,
			EnableBlinkDetection:        true,
			EnableGazeDetection:         true,
		})
		go beginSensorEventStream(robot, robotIndex, ctx)
		go beginNavMapStream(robot, robotIndex, ctx)
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/stop_sensor_stream":
		robots[robotIndex].SensorStreaming = false
		robots[robotIndex].NavMapStreaming = false
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	case r.URL.Path == "/api-sdk/sensor_status":
		robots[robotIndex].Sensors.Timestamp = time.Now().UnixMilli()
		// Return faces then clear (faces are event-based, not continuous)
		jsonBytes, _ := json.Marshal(robots[robotIndex].Sensors)
		robots[robotIndex].Sensors.Faces = nil
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonBytes)
		return
	case r.URL.Path == "/api-sdk/nav_map_status":
		jsonBytes, _ := json.Marshal(robots[robotIndex].NavMap)
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonBytes)
		return
	case r.URL.Path == "/api-sdk/event_log":
		sinceStr := r.FormValue("since")
		sinceMs, _ := strconv.ParseInt(sinceStr, 10, 64)
		robots[robotIndex].EventLogMu.Lock()
		var filtered []EventLogEntry
		for _, e := range robots[robotIndex].EventLog {
			if e.Time > sinceMs {
				filtered = append(filtered, e)
			}
		}
		robots[robotIndex].EventLogMu.Unlock()
		if filtered == nil {
			filtered = []EventLogEntry{}
		}
		jsonBytes, _ := json.Marshal(filtered)
		w.Header().Set("Content-Type", "application/json")
		w.Write(jsonBytes)
		return
	case r.URL.Path == "/api-sdk/set_cube_lights":
		c1 := r.FormValue("c1")
		c2 := r.FormValue("c2")
		c3 := r.FormValue("c3")
		c4 := r.FormValue("c4")
		parseColor := func(hex string) uint32 {
			hex = strings.TrimPrefix(hex, "#")
			val, _ := strconv.ParseUint(hex, 16, 32)
			// Convert RGB hex to the format Vector expects (0x00RRGGBB)
			return uint32(val)
		}
		colors := []uint32{parseColor(c1), parseColor(c2), parseColor(c3), parseColor(c4)}
		off := []uint32{0, 0, 0, 0}
		on := []uint32{500, 500, 500, 500}
		offMs := []uint32{0, 0, 0, 0}
		transOn := []uint32{0, 0, 0, 0}
		transOff := []uint32{0, 0, 0, 0}
		offsets := []int32{0, 0, 0, 0}
		_, err := robot.Conn.SetCubeLights(ctx, &vectorpb.SetCubeLightsRequest{
			OnColor:               colors,
			OffColor:              off,
			OnPeriodMs:            on,
			OffPeriodMs:           offMs,
			TransitionOnPeriodMs:  transOn,
			TransitionOffPeriodMs: transOff,
			Offset:                offsets,
		})
		if err != nil {
			fmt.Fprint(w, `{"error":"`+err.Error()+`"}`)
			return
		}
		fmt.Fprint(w, `{"status":"ok"}`)
		return
	}
}

func camStreamHandler(w http.ResponseWriter, r *http.Request) {
	robotObj, robotIndex, err := getRobot(r.FormValue("serial"))
	if err != nil {
		fmt.Fprint(w, "error: "+err.Error())
		return
	}
	if robots[robotIndex].CamStreaming {
		robots[robotIndex].CamStreaming = false
		time.Sleep(time.Second / 2)
	}
	robotObj.Vector.Conn.EnableImageStreaming(
		robotObj.Ctx,
		&vectorpb.EnableImageStreamingRequest{
			Enable: true,
		},
	)
	var client vectorpb.ExternalInterface_CameraFeedClient
	client, err = robotObj.Vector.Conn.CameraFeed(
		robotObj.Ctx,
		&vectorpb.CameraFeedRequest{},
	)
	if err != nil {
		fmt.Fprint(w, "error: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "multipart/x-mixed-replace; boundary=--boundary")
	multi := io.MultiWriter(w)
	robots[robotIndex].CamStreaming = true
	for {
		select {
		case <-r.Context().Done():
			robotObj.Vector.Conn.EnableImageStreaming(
				robotObj.Ctx,
				&vectorpb.EnableImageStreamingRequest{
					Enable: false,
				},
			)
			robots[robotIndex].CamStreaming = false
			return
		default:
			if robots[robotIndex].CamStreaming {
				response, err := client.Recv()
				if err == nil {
					imageBytes := response.GetData()
					img, _, _ := image.Decode(bytes.NewReader(imageBytes))
					fmt.Fprintf(multi, "--boundary\r\nContent-Type: image/jpeg\r\n\r\n")
					jpeg.Encode(multi, img, &jpeg.Options{
						Quality: 50,
					})
				}
			} else {
				robotObj.Vector.Conn.EnableImageStreaming(
					robotObj.Ctx,
					&vectorpb.EnableImageStreamingRequest{
						Enable: false,
					},
				)
				return
			}
		}
	}
}

func DisableCachingAndSniffing(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate;")
		w.Header().Set("pragma", "no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func BeginServer() {
	scripting.RegisterScriptingAPI()
	if os.Getenv("JDOCS_PINGER_ENABLED") == "false" {
		PingerEnabled = false
		logger.Println("Jdocs pinger has been disabled")
	}
	http.HandleFunc("/api-sdk/", SdkapiHandler)
	if runtime.GOOS == "android" || runtime.GOOS == "ios" {
		serverFiles = filepath.Join(vars.AndroidPath, "/static/webroot")
	}
	fileServer := http.FileServer(http.Dir(serverFiles))
	http.Handle("/sdk-app", DisableCachingAndSniffing(fileServer))
	// in jdocspinger.go
	http.HandleFunc("/ok:80", connCheck)
	http.HandleFunc("/ok", connCheck)
	InitJdocsPinger()
	// camstream
	http.HandleFunc("/cam-stream", camStreamHandler)
	logger.Println("Starting SDK app")
	fmt.Printf("Starting server at port 80 for connCheck\n")
	ipAddr := vars.GetOutboundIP().String()
	logger.Println("\033[1;36mConfiguration page: http://" + ipAddr + ":" + vars.WebPort + "\033[0m")
	if runtime.GOOS != "android" {
		if err := http.ListenAndServe(":80", nil); err != nil {
			if vars.Packaged {
				logger.WarnMsg("A process is using port 80. Wire-pod will keep running, but connCheck functionality will not work, so your bot may not always stay connected to your wire-pod instance.")
			}
			logger.Println("A process is already using port 80 - connCheck functionality will not work")
		}
	}
}

// ===== Sensor Dashboard Streaming =====

func addEventLog(robotIndex int, eventType, message string) {
	robots[robotIndex].EventLogMu.Lock()
	defer robots[robotIndex].EventLogMu.Unlock()
	entry := EventLogEntry{
		Time:    time.Now().UnixMilli(),
		Type:    eventType,
		Message: message,
	}
	robots[robotIndex].EventLog = append(robots[robotIndex].EventLog, entry)
	if len(robots[robotIndex].EventLog) > 200 {
		robots[robotIndex].EventLog = robots[robotIndex].EventLog[1:]
	}
}

func beginSensorEventStream(robot *vector.Vector, robotIndex int, ctx context.Context) {
	client, err := robot.Conn.EventStream(
		ctx,
		&vectorpb.EventRequest{
			ListType: &vectorpb.EventRequest_WhiteList{
				WhiteList: &vectorpb.FilterList{
					List: []string{
						"robot_state",
						"object_event",
						"cube_battery",
						"stimulation_info",
						"robot_observed_face",
						"wake_word",
						"user_intent",
					},
				},
			},
			ConnectionId: "wirepod_sensors",
		},
	)
	if err != nil {
		logger.Println("Sensor stream error: " + err.Error())
		robots[robotIndex].SensorStreaming = false
		return
	}
	addEventLog(robotIndex, "status", "Sensor stream started")

	lastFaceLogKey := ""
	for {
		if !robots[robotIndex].SensorStreaming {
			return
		}
		resp, err := client.Recv()
		if err != nil {
			logger.Println("Sensor stream recv error: " + err.Error())
			robots[robotIndex].SensorStreaming = false
			addEventLog(robotIndex, "status", "Sensor stream disconnected: "+err.Error())
			return
		}
		evt := resp.GetEvent()
		if evt == nil {
			continue
		}

		s := &robots[robotIndex].Sensors

		// --- robot_state ---
		if rs := evt.GetRobotState(); rs != nil {
			if pose := rs.GetPose(); pose != nil {
				s.RobotX = pose.GetX()
				s.RobotY = pose.GetY()
				s.RobotZ = pose.GetZ()
				s.RobotQ0 = pose.GetQ0()
				s.RobotQ1 = pose.GetQ1()
				s.RobotQ2 = pose.GetQ2()
				s.RobotQ3 = pose.GetQ3()
			}
			s.RobotAngleRad = rs.GetPoseAngleRad()
			s.PosePitchRad = rs.GetPosePitchRad()
			s.HeadAngleRad = rs.GetHeadAngleRad()
			s.LiftHeightMm = rs.GetLiftHeightMm()
			s.LeftWheelSpeedMmps = rs.GetLeftWheelSpeedMmps()
			s.RightWheelSpeedMmps = rs.GetRightWheelSpeedMmps()

			if accel := rs.GetAccel(); accel != nil {
				s.AccelX = accel.GetX()
				s.AccelY = accel.GetY()
				s.AccelZ = accel.GetZ()
			}
			if gyro := rs.GetGyro(); gyro != nil {
				s.GyroX = gyro.GetX()
				s.GyroY = gyro.GetY()
				s.GyroZ = gyro.GetZ()
			}
			if prox := rs.GetProxData(); prox != nil {
				s.ProxDistanceMm = prox.GetDistanceMm()
				s.ProxSignalQual = prox.GetSignalQuality()
				s.ProxFoundObject = prox.GetFoundObject()
				s.ProxLiftInFov = prox.GetIsLiftInFov()
				s.ProxUnobstructed = prox.GetUnobstructed()
			}
			if touch := rs.GetTouchData(); touch != nil {
				s.TouchRawValue = touch.GetRawTouchValue()
				s.IsBeingTouched = touch.GetIsBeingTouched()
			}

			status := rs.GetStatus()
			s.IsMoving = (status & 0x1) != 0
			s.IsCarrying = (status & 0x2) != 0
			s.IsPickedUp = (status & 0x8) != 0
			s.IsButtonPress = (status & 0x10) != 0
			s.IsFalling = (status & 0x20) != 0
			s.IsAnimating = (status & 0x40) != 0
			s.IsPathing = (status & 0x80) != 0
			s.IsCalm = (status & 0x400) != 0
			s.IsOnCharger = (status & 0x1000) != 0
			s.IsCharging = (status & 0x2000) != 0
			s.IsCliffDetect = (status & 0x4000) != 0
			s.AreWheelsMoving = (status & 0x8000) != 0
			s.IsBeingHeld = (status & 0x10000) != 0

			// Decay object visibility TTLs (~50Hz ticks, 150 ticks ≈ 3 sec)
			if s.chargerTTL > 0 {
				s.chargerTTL--
				if s.chargerTTL == 0 {
					s.ChargerVisible = false
				}
			}
			if s.cubeTTL > 0 {
				s.cubeTTL--
				if s.cubeTTL == 0 {
					s.CubeVisible = false
				}
			}
		}

		// --- object_event ---
		if objEvt := evt.GetObjectEvent(); objEvt != nil {
			if obs := objEvt.GetRobotObservedObject(); obs != nil {
				if pose := obs.GetPose(); pose != nil {
					objType := obs.GetObjectType()
					if objType == vectorpb.ObjectType_CHARGER_BASIC {
						s.ChargerX = pose.GetX()
						s.ChargerY = pose.GetY()
						s.ChargerZ = pose.GetZ()
						s.ChargerVisible = true
						s.chargerTTL = 150 // ~3 sec at 50Hz
					} else {
						s.CubeX = pose.GetX()
						s.CubeY = pose.GetY()
						s.CubeZ = pose.GetZ()
						s.CubeVisible = true
						s.cubeTTL = 150 // ~3 sec at 50Hz
					}
				}
			}
			if objEvt.GetObjectMoved() != nil {
				addEventLog(robotIndex, "object", "Object moved")
			}
			if objEvt.GetObjectTapped() != nil {
				addEventLog(robotIndex, "object", "Object tapped")
			}
			if cs := objEvt.GetObjectConnectionState(); cs != nil {
				if cs.GetConnected() {
					addEventLog(robotIndex, "object", "Cube connected: "+cs.GetFactoryId())
				} else {
					addEventLog(robotIndex, "object", "Cube disconnected")
				}
			}
		}

		// --- robot_observed_face ---
		if face := evt.GetRobotObservedFace(); face != nil {
			exprNames := []string{"unknown", "neutral", "happy", "surprise", "angry", "sad"}
			exprIdx := int(face.GetExpression())
			exprStr := "unknown"
			if exprIdx >= 0 && exprIdx < len(exprNames) {
				exprStr = exprNames[exprIdx]
			}

			faceName := face.GetName()
			if faceName == "" {
				faceName = "unknown"
			}

			s.FaceId = face.GetFaceId()
			s.FaceName = faceName
			s.FaceExpression = exprStr

			// Build full face detection with landmarks
			fd := FaceDetection{
				FaceId:           face.GetFaceId(),
				Name:             faceName,
				Expression:       exprStr,
				ExpressionValues: face.GetExpressionValues(),
			}
			if rect := face.GetImgRect(); rect != nil {
				fd.ImgRect = [4]float32{rect.GetXTopLeft(), rect.GetYTopLeft(), rect.GetWidth(), rect.GetHeight()}
			}
			if pose := face.GetPose(); pose != nil {
				fd.PoseX = pose.GetX()
				fd.PoseY = pose.GetY()
				fd.PoseZ = pose.GetZ()
			}
			for _, pt := range face.GetLeftEye() {
				fd.LeftEye = append(fd.LeftEye, [2]float32{pt.GetX(), pt.GetY()})
			}
			for _, pt := range face.GetRightEye() {
				fd.RightEye = append(fd.RightEye, [2]float32{pt.GetX(), pt.GetY()})
			}
			for _, pt := range face.GetNose() {
				fd.Nose = append(fd.Nose, [2]float32{pt.GetX(), pt.GetY()})
			}
			for _, pt := range face.GetMouth() {
				fd.Mouth = append(fd.Mouth, [2]float32{pt.GetX(), pt.GetY()})
			}

			// Keep last 5 faces (may see multiple)
			s.Faces = append(s.Faces, fd)
			if len(s.Faces) > 5 {
				s.Faces = s.Faces[len(s.Faces)-5:]
			}

			// Debounce face log: only log if face ID or expression changed
			logKey := fmt.Sprintf("%d_%s", face.GetFaceId(), exprStr)
			if logKey != lastFaceLogKey {
				lastFaceLogKey = logKey
				addEventLog(robotIndex, "face",
					fmt.Sprintf("Face: %s (id=%d, %s)", faceName, face.GetFaceId(), exprStr))
			}
		}

		// --- stimulation_info ---
		if stim := evt.GetStimulationInfo(); stim != nil {
			stimStr := fmt.Sprint(stim)
			if strings.Contains(stimStr, "velocity") {
				s.StimValue = stim.Value
			}
		}

		// --- wake_word ---
		if evt.GetWakeWord() != nil {
			addEventLog(robotIndex, "wake", "Wake word detected!")
		}

		// --- user_intent ---
		if intent := evt.GetUserIntent(); intent != nil {
			addEventLog(robotIndex, "intent",
				fmt.Sprintf("Intent: %d", intent.GetIntentId()))
		}
	}
}

func beginNavMapStream(robot *vector.Vector, robotIndex int, ctx context.Context) {
	robots[robotIndex].NavMapStreaming = true
	navClient, err := robot.Conn.NavMapFeed(ctx, &vectorpb.NavMapFeedRequest{
		Frequency: 2,
	})
	if err != nil {
		logger.Println("NavMap stream error: " + err.Error())
		robots[robotIndex].NavMapStreaming = false
		return
	}
	logger.Println("NavMap stream started")

	for {
		if !robots[robotIndex].NavMapStreaming || !robots[robotIndex].SensorStreaming {
			return
		}
		resp, err := navClient.Recv()
		if err != nil {
			logger.Println("NavMap recv error: " + err.Error())
			robots[robotIndex].NavMapStreaming = false
			// Auto-restart after 2s (known ~5min drop issue)
			time.Sleep(2 * time.Second)
			if robots[robotIndex].SensorStreaming {
				go beginNavMapStream(robot, robotIndex, ctx)
			}
			return
		}

		mapInfo := resp.GetMapInfo()
		if mapInfo == nil {
			continue
		}
		quads := resp.GetQuadInfos()

		rootDepth := int(mapInfo.GetRootDepth())
		sizeMm := mapInfo.GetRootSizeMm()
		centerX := mapInfo.GetRootCenterX()
		centerY := mapInfo.GetRootCenterY()

		leaves := quadtreeToLeaves(quads, rootDepth, centerX, centerY, sizeMm)

		robots[robotIndex].NavMap = NavMapGrid{
			OriginId:  resp.GetOriginId(),
			CenterX:   centerX,
			CenterY:   centerY,
			SizeMm:    sizeMm,
			Leaves:    leaves,
			Timestamp: time.Now().UnixMilli(),
		}
	}
}

// quadtreeToLeaves converts the depth-first quadtree into a list of leaf nodes
// with world coordinates. Matches Python SDK NavMapGridNode exactly:
//   child 0: center(x+offset, y+offset) — NE
//   child 1: center(x+offset, y-offset) — SE
//   child 2: center(x-offset, y+offset) — NW
//   child 3: center(x-offset, y-offset) — SW
func quadtreeToLeaves(quads []*vectorpb.NavMapQuadInfo, rootDepth int, centerX, centerY, sizeMm float32) []NavMapLeaf {
	idx := 0
	var leaves []NavMapLeaf

	var walk func(cx, cy, sz float32, nodeDepth int)
	walk = func(cx, cy, sz float32, nodeDepth int) {
		if idx >= len(quads) {
			return
		}

		targetDepth := int(quads[idx].GetDepth())

		if nodeDepth == targetDepth {
			// Leaf — store with world coordinates
			content := int(quads[idx].GetContent())
			idx++
			leaves = append(leaves, NavMapLeaf{X: cx, Y: cy, Size: sz, Content: content})
		} else if nodeDepth > targetDepth {
			// Branch — subdivide (DO NOT consume a quad)
			halfSz := sz / 2.0
			offset := halfSz / 2.0
			cd := nodeDepth - 1
			walk(cx+offset, cy+offset, halfSz, cd) // child 0: NE
			walk(cx+offset, cy-offset, halfSz, cd) // child 1: SE
			walk(cx-offset, cy+offset, halfSz, cd) // child 2: NW
			walk(cx-offset, cy-offset, halfSz, cd) // child 3: SW
		}
	}

	walk(centerX, centerY, sizeMm, rootDepth)

	nonZero := 0
	for _, l := range leaves {
		if l.Content != 0 {
			nonZero++
		}
	}
	logger.Println(fmt.Sprintf("NavMap: depth=%d, %d/%d quads, %d leaves (%d non-zero)",
		rootDepth, idx, len(quads), len(leaves), nonZero))

	return leaves
}

func rgbToBytes(rgbValues [][][3]uint8) ([]byte, error) {
	var buffer bytes.Buffer

	for _, row := range rgbValues {
		for _, pixel := range row {
			// Directly add the R, G and B values ​​to the buffer
			buffer.WriteByte(pixel[0]) // R
			buffer.WriteByte(pixel[1]) // G
			buffer.WriteByte(pixel[2]) // B
		}
	}

	return buffer.Bytes(), nil
}
func imageToBytes(img image.Image) ([]byte, error) {
	bounds := img.Bounds()
	var buffer bytes.Buffer

	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			// Obtém a cor do pixel
			c := img.At(x, y)
			r, g, b, _ := c.RGBA() // Ignorando o valor Alpha

			// Converte de uint32 para uint8
			buffer.WriteByte(uint8(r >> 8))
			buffer.WriteByte(uint8(g >> 8))
			buffer.WriteByte(uint8(b >> 8))
		}
	}

	return buffer.Bytes(), nil
}

func resizeImage(original image.Image, width, height int) image.Image {
	if width <= 0 || height <= 0 {
		return original
	}

	newImage := image.NewRGBA(image.Rect(0, 0, width, height))

	scaleX := float64(original.Bounds().Dx()) / float64(width)
	scaleY := float64(original.Bounds().Dy()) / float64(height)

	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			srcX := int(float64(x) * scaleX)
			srcY := int(float64(y) * scaleY)
			newImage.Set(x, y, original.At(srcX, srcY))
		}
	}

	return newImage
}
