import sys
import os
import time
import subprocess
import json

# Ensure we can import modules from the environment
try:
    import garth
except ImportError:
    print("[WRAPPER] Error: 'garth' module not found. Is it installed?")
    sys.exit(1)

# Configuration matching GarminDB's defaults
GARMINDB_DIR = os.path.expanduser("~/.GarminDb")
SESSION_DIR = os.path.join(GARMINDB_DIR, "garth_session")

def main():
    print("[WRAPPER] Starting Garmin Auth Wrapper...")
    
    # 1. Try to resume existing session
    session_valid = False
    try:
        if os.path.exists(SESSION_DIR):
            garth.resume(SESSION_DIR)
            # rapid check?
            try:
                garth.client.username
                session_valid = True
                print("[WRAPPER] Session resumed successfully.")
            except:
                print("[WRAPPER] Session invalid/expired.")
    except Exception as e:
        print(f"[WRAPPER] Failed to resume session: {e}")

    # 2. If not valid, valid, perform login
    if not session_valid:
        print("[WRAPPER] No valid session found. Starting interactive login...")
        
        # PROMPTS MUST MATCH THE REGEX IN SERVER.JS
        # "Username: " and "Password: "
        
        print("Username:")
        sys.stdout.flush()
        email = sys.stdin.readline().strip()
        if not email:
            print("[WRAPPER] No email provided. Aborting.")
            sys.exit(1)
            
        print("Password:")
        sys.stdout.flush()
        password = sys.stdin.readline().strip()
        if not password:
            print("[WRAPPER] No password provided. Aborting.")
            sys.exit(1)

        try:
            # garth.login handles MFA interactive prompts if needed (hopefully prints to stdout)
            garth.login(email, password)
            print("[WRAPPER] Login successful!")
            
            # Save session for GarminDB to use
            if not os.path.exists(SESSION_DIR):
                os.makedirs(SESSION_DIR)
            garth.save(SESSION_DIR)
            print(f"[WRAPPER] Session saved to {SESSION_DIR}")

            # CRITICAL FIX: GarminDB strictly requires credentials in the config file
            # or it fails with "Missing config" and crashes.
            # Since we have the valid credentials here, we write them to the config.
            config_file = os.path.join(GARMINDB_DIR, "GarminConnectConfig.json")
            try:
                config_data = {}
                if os.path.exists(config_file):
                    with open(config_file, 'r') as f:
                        try:
                            config_data = json.load(f)
                        except json.JSONDecodeError:
                            config_data = {}
                
                # Ensure structure exists
                if "credentials" not in config_data:
                    config_data["credentials"] = {}
                
                config_data["credentials"]["username"] = email
                config_data["credentials"]["password"] = password
                
                with open(config_file, 'w') as f:
                    json.dump(config_data, f, indent=4)
                print(f"[WRAPPER] Credentials written to {config_file}")
                
                # Verify content (redacted)
                with open(config_file, 'r') as f:
                    verify_data = json.load(f)
                    user = verify_data.get('credentials', {}).get('username')
                    print(f"[WRAPPER] VERIFICATION: Config file contains username: {user}")
                
            except Exception as e:
                print(f"[WRAPPER] Warning: Failed to write config file: {e}")
            
        except Exception as e:
            print(f"[WRAPPER] Login failed: {e}")
            sys.exit(1)

    # 3. Launch the actual CLI tool
    
    if len(sys.argv) < 2:
        print("[WRAPPER] Error: No target executable specified.")
        sys.exit(1)

    target_cli = sys.argv[1]
    args = sys.argv[1:]
    
    # Force use of our config file
    config_file_path = os.path.join(GARMINDB_DIR, "GarminConnectConfig.json")
    if "-f" not in args:
        print(f"[WRAPPER] Injecting -f {config_file_path}")
        args = [target_cli, "-f", config_file_path] + sys.argv[2:]
    else:
        args = [target_cli] + sys.argv[2:]

    # execvp expects the first element to be the executable name
    cmd = args
    
    # Ensure command starts with the executable name for execvp
    if cmd[0] != target_cli:
        cmd.insert(0, target_cli)
        
    print(f"[WRAPPER] Launching: {' '.join(cmd)}")
    print("---------------------------------------------------")
    sys.stdout.flush()

    try:
        os.execvp(target_cli, cmd)
    except FileNotFoundError:
        print(f"[WRAPPER] Error: {target_cli} not found in PATH.")
        sys.exit(1)

if __name__ == "__main__":
    main()
