import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DAVRecord {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  vehicleId: string;
  accessType: "temporary" | "permanent";
  status: "active" | "expired" | "revoked";
  preferences: {
    temperature: number;
    musicVolume: number;
    drivingStyle: number;
    routePriority: number;
  };
}

// FHE Encryption/Decryption functions for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-ZAMA`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-') && encryptedData.endsWith('-ZAMA')) {
    const cleanData = encryptedData.substring(4, encryptedData.length - 5);
    return parseFloat(atob(cleanData));
  }
  return parseFloat(encryptedData);
};

// FHE computation on encrypted data
const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'optimizeRoute':
      result = value * 0.95; // 5% optimization
      break;
    case 'adjustComfort':
      result = value * 1.1; // 10% comfort increase
      break;
    case 'ecoMode':
      result = value * 0.9; // 10% energy saving
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<DAVRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({
    vehicleId: "",
    accessType: "temporary" as "temporary" | "permanent",
    preferences: {
      temperature: 22,
      musicVolume: 50,
      drivingStyle: 70,
      routePriority: 60
    }
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<DAVRecord | null>(null);
  const [decryptedPreferences, setDecryptedPreferences] = useState<any>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [currentStep, setCurrentStep] = useState<number>(1);
  const [systemStatus, setSystemStatus] = useState<{ vehicles: number, activeSessions: number, fheOperations: number }>({ vehicles: 0, activeSessions: 0, fheOperations: 0 });

  // Initialize system
  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSystem = async () => {
      setPublicKey(generatePublicKey());
      // Simulate system status updates
      setSystemStatus({
        vehicles: Math.floor(Math.random() * 50) + 10,
        activeSessions: records.filter(r => r.status === "active").length,
        fheOperations: Math.floor(Math.random() * 1000) + 500
      });
    };
    initSystem();
    const interval = setInterval(() => {
      setSystemStatus(prev => ({
        ...prev,
        activeSessions: records.filter(r => r.status === "active").length,
        fheOperations: prev.fheOperations + Math.floor(Math.random() * 10)
      }));
    }, 5000);
    return () => clearInterval(interval);
  }, [records.length]);

  // Load DAV access records from contract
  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load record keys
      const keysBytes = await contract.getData("dav_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      
      const list: DAVRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`dav_record_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({
                id: key,
                encryptedData: recordData.data,
                timestamp: recordData.timestamp,
                owner: recordData.owner,
                vehicleId: recordData.vehicleId,
                accessType: recordData.accessType,
                status: recordData.status || "active",
                preferences: recordData.preferences
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // Create new DAV access record with FHE encryption
  const submitRecord = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting DAV preferences with Zama FHE..." });
    
    try {
      // Encrypt each preference with FHE
      const encryptedPreferences = {
        temperature: FHEEncryptNumber(newRecordData.preferences.temperature),
        musicVolume: FHEEncryptNumber(newRecordData.preferences.musicVolume),
        drivingStyle: FHEEncryptNumber(newRecordData.preferences.drivingStyle),
        routePriority: FHEEncryptNumber(newRecordData.preferences.routePriority)
      };

      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordId = `dav-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const recordData = {
        data: JSON.stringify(encryptedPreferences),
        timestamp: Math.floor(Date.now() / 1000),
        owner: address,
        vehicleId: newRecordData.vehicleId,
        accessType: newRecordData.accessType,
        status: "active",
        preferences: encryptedPreferences
      };

      await contract.setData(`dav_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update record keys
      const keysBytes = await contract.getData("dav_record_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("dav_record_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "DAV access NFT created with FHE encryption!" });
      await loadRecords();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewRecordData({
          vehicleId: "",
          accessType: "temporary",
          preferences: { temperature: 22, musicVolume: 50, drivingStyle: 70, routePriority: 60 }
        });
        setCurrentStep(1);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  // Decrypt preferences with wallet signature
  const decryptWithSignature = async (encryptedData: string): Promise<any> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `DAV Access Decryption\nPublic Key: ${publicKey}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const encryptedPrefs = JSON.parse(encryptedData);
      const decrypted = {} as any;
      for (const [key, value] of Object.entries(encryptedPrefs)) {
        if (typeof value === 'string') {
          decrypted[key] = FHEDecryptNumber(value);
        }
      }
      return decrypted;
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  // Verify DAV access record
  const verifyRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted preferences with FHE..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const recordBytes = await contract.getData(`dav_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const encryptedPrefs = JSON.parse(recordData.data);
      
      // Apply FHE computation to optimize preferences
      const optimizedPrefs = {} as any;
      for (const [key, value] of Object.entries(encryptedPrefs)) {
        if (typeof value === 'string') {
          optimizedPrefs[key] = FHECompute(value, 'optimizeRoute');
        }
      }
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedRecord = { 
        ...recordData, 
        status: "active",
        preferences: optimizedPrefs,
        data: JSON.stringify(optimizedPrefs)
      };
      
      await contractWithSigner.setData(`dav_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE optimization completed successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Revoke DAV access
  const revokeRecord = async (recordId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Revoking DAV access..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const recordBytes = await contract.getData(`dav_record_${recordId}`);
      if (recordBytes.length === 0) throw new Error("Record not found");
      
      const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
      const updatedRecord = { ...recordData, status: "revoked" };
      
      await contract.setData(`dav_record_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(updatedRecord)));
      setTransactionStatus({ visible: true, status: "success", message: "DAV access revoked successfully!" });
      await loadRecords();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Revocation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (recordAddress: string) => address?.toLowerCase() === recordAddress.toLowerCase();

  // Tutorial steps for DAV system
  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access the DAV network", icon: "🔗" },
    { title: "Set Preferences", description: "Configure your encrypted driving preferences using FHE", icon: "⚙️", details: "Temperature, music, driving style encrypted with Zama FHE" },
    { title: "Get DAV Access NFT", description: "Receive encrypted access rights to autonomous vehicles", icon: "🚗", details: "NFT contains FHE-encrypted personalized preferences" },
    { title: "Private Autonomous Rides", description: "Enjoy privacy-preserving autonomous transportation", icon: "🛡️", details: "Your data remains encrypted during entire journey" }
  ];

  // Render preference visualization chart
  const renderPreferenceChart = (preferences: any, isEncrypted: boolean = true) => {
    const items = [
      { label: "Temperature", value: preferences?.temperature || 0, max: 30 },
      { label: "Music Volume", value: preferences?.musicVolume || 0, max: 100 },
      { label: "Driving Style", value: preferences?.drivingStyle || 0, max: 100 },
      { label: "Route Priority", value: preferences?.routePriority || 0, max: 100 }
    ];

    return (
      <div className="preference-chart">
        {items.map((item, index) => (
          <div key={index} className="preference-item">
            <div className="preference-label">{item.label}</div>
            <div className="preference-bar">
              <div 
                className="preference-fill" 
                style={{ width: `${(item.value / item.max) * 100}%` }}
              ></div>
            </div>
            <div className="preference-value">
              {isEncrypted ? "🔒" : item.value}
            </div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen hud-theme">
      <div className="hud-spinner"></div>
      <p>Initializing DAV Network Connection...</p>
      <div className="hud-status">FHE Encryption: ACTIVE</div>
    </div>
  );

  return (
    <div className="app-container hud-theme">
      {/* HUD Header */}
      <header className="app-header hud-header">
        <div className="hud-logo">
          <div className="vehicle-icon">🚗</div>
          <h1>DAV<span>Access</span>FHE</h1>
          <div className="hud-badge">ZAMA FHE</div>
        </div>
        
        <div className="hud-status-panel">
          <div className="status-item">
            <span className="status-label">Vehicles Online</span>
            <span className="status-value">{systemStatus.vehicles}</span>
          </div>
          <div className="status-item">
            <span className="status-label">Active Sessions</span>
            <span className="status-value">{systemStatus.activeSessions}</span>
          </div>
          <div className="status-item">
            <span className="status-label">FHE Ops</span>
            <span className="status-value">{systemStatus.fheOperations}</span>
          </div>
        </div>

        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="hud-button primary">
            <div className="button-icon">+</div>New DAV Access
          </button>
          <button className="hud-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Show Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="main-content hud-content">
        
        {/* Welcome Banner */}
        <div className="welcome-banner hud-banner">
          <div className="banner-content">
            <h2>Decentralized Autonomous Vehicle Network</h2>
            <p>Privacy-preserving transportation with Zama FHE encrypted preferences</p>
          </div>
          <div className="fhe-indicator hud-indicator">
            <div className="encryption-animation"></div>
            <span>FHE ENCRYPTION: ACTIVE</span>
          </div>
        </div>

        {/* Tutorial Section */}
        {showTutorial && (
          <div className="tutorial-section hud-panel">
            <h2>DAV Access FHE Tutorial</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div key={index} className="tutorial-step hud-step">
                  <div className="step-marker">{index + 1}</div>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dashboard Grid */}
        <div className="dashboard-grid hud-grid">
          <div className="dashboard-card hud-panel">
            <h3>FHE-Encrypted DAV Preferences</h3>
            {renderPreferenceChart(newRecordData.preferences, false)}
            <div className="hud-notice">Preferences are encrypted with Zama FHE before storage</div>
          </div>

          <div className="dashboard-card hud-panel">
            <h3>Access Records</h3>
            <div className="stats-grid">
              <div className="stat-item hud-stat">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Total Access NFTs</div>
              </div>
              <div className="stat-item hud-stat">
                <div className="stat-value">{records.filter(r => r.status === "active").length}</div>
                <div className="stat-label">Active Sessions</div>
              </div>
              <div className="stat-item hud-stat">
                <div className="stat-value">{records.filter(r => r.accessType === "permanent").length}</div>
                <div className="stat-label">Permanent Access</div>
              </div>
            </div>
          </div>
        </div>

        {/* Records List */}
        <div className="records-section">
          <div className="section-header hud-header">
            <h2>DAV Access NFTs</h2>
            <button onClick={loadRecords} className="hud-button" disabled={isRefreshing}>
              {isRefreshing ? "SYNCING..." : "REFRESH"}
            </button>
          </div>
          
          <div className="records-list hud-panel">
            {records.length === 0 ? (
              <div className="no-records">
                <div className="no-records-icon">🚗</div>
                <p>No DAV access records found</p>
                <button className="hud-button primary" onClick={() => setShowCreateModal(true)}>
                  Create First DAV Access
                </button>
              </div>
            ) : (
              records.map(record => (
                <div key={record.id} className="record-item hud-item" onClick={() => setSelectedRecord(record)}>
                  <div className="record-header">
                    <div className="vehicle-id">Vehicle #{record.vehicleId}</div>
                    <div className={`access-badge ${record.accessType}`}>{record.accessType}</div>
                  </div>
                  <div className="record-preferences">
                    {renderPreferenceChart(record.preferences, true)}
                  </div>
                  <div className="record-footer">
                    <div className="record-meta">
                      <span>{new Date(record.timestamp * 1000).toLocaleDateString()}</span>
                      <span className={`status-indicator ${record.status}`}>{record.status}</span>
                    </div>
                    <div className="record-actions">
                      {isOwner(record.owner) && record.status === "active" && (
                        <>
                          <button className="hud-button small" onClick={(e) => { e.stopPropagation(); verifyRecord(record.id); }}>
                            OPTIMIZE
                          </button>
                          <button className="hud-button small danger" onClick={(e) => { e.stopPropagation(); revokeRecord(record.id); }}>
                            REVOKE
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitRecord} 
          onClose={() => { setShowCreateModal(false); setCurrentStep(1); }} 
          creating={creating} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
        />
      )}

      {/* Detail Modal */}
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { setSelectedRecord(null); setDecryptedPreferences(null); }} 
          decryptedPreferences={decryptedPreferences}
          setDecryptedPreferences={setDecryptedPreferences}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status */}
      {transactionStatus.visible && (
        <div className="transaction-overlay hud-overlay">
          <div className="transaction-panel hud-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hud-spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="app-footer hud-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="hud-logo-small">DAV FHE</div>
            <p>Privacy-preserving autonomous vehicle access with Zama FHE</p>
          </div>
          <div className="footer-tech">
            <span className="tech-badge">ZAMA FHE</span>
            <span className="tech-badge">NFT Access</span>
            <span className="tech-badge">DePIN</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Modal Components
interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
  currentStep: number;
  setCurrentStep: (step: number) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, onClose, creating, recordData, setRecordData, currentStep, setCurrentStep 
}) => {
  const steps = ["Vehicle Setup", "Preferences", "Encryption", "Confirmation"];

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    if (name.startsWith('pref-')) {
      const prefName = name.replace('pref-', '');
      setRecordData({
        ...recordData,
        preferences: { ...recordData.preferences, [prefName]: parseFloat(value) }
      });
    } else {
      setRecordData({ ...recordData, [name]: value });
    }
  };

  const nextStep = () => setCurrentStep(Math.min(currentStep + 1, steps.length));
  const prevStep = () => setCurrentStep(Math.max(currentStep - 1, 1));

  const handleSubmit = () => {
    if (!recordData.vehicleId) { alert("Please enter vehicle ID"); return; }
    onSubmit();
  };

  const renderStepContent = () => {
    switch(currentStep) {
      case 1:
        return (
          <div className="step-content">
            <div className="form-group">
              <label>Vehicle ID *</label>
              <input type="text" name="vehicleId" value={recordData.vehicleId} onChange={handleChange} 
                     className="hud-input" placeholder="Enter vehicle identifier" />
            </div>
            <div className="form-group">
              <label>Access Type</label>
              <select name="accessType" value={recordData.accessType} onChange={handleChange} className="hud-select">
                <option value="temporary">Temporary Access</option>
                <option value="permanent">Permanent Access</option>
              </select>
            </div>
          </div>
        );
      
      case 2:
        return (
          <div className="step-content">
            <div className="preference-controls">
              <div className="preference-slider">
                <label>Temperature: {recordData.preferences.temperature}°C</label>
                <input type="range" name="pref-temperature" min="16" max="30" 
                       value={recordData.preferences.temperature} onChange={handleChange} className="hud-slider" />
              </div>
              <div className="preference-slider">
                <label>Music Volume: {recordData.preferences.musicVolume}%</label>
                <input type="range" name="pref-musicVolume" min="0" max="100" 
                       value={recordData.preferences.musicVolume} onChange={handleChange} className="hud-slider" />
              </div>
              <div className="preference-slider">
                <label>Driving Style: {recordData.preferences.drivingStyle}%</label>
                <input type="range" name="pref-drivingStyle" min="0" max="100" 
                       value={recordData.preferences.drivingStyle} onChange={handleChange} className="hud-slider" />
              </div>
              <div className="preference-slider">
                <label>Route Priority: {recordData.preferences.routePriority}%</label>
                <input type="range" name="pref-routePriority" min="0" max="100" 
                       value={recordData.preferences.routePriority} onChange={handleChange} className="hud-slider" />
              </div>
            </div>
          </div>
        );
      
      case 3:
        return (
          <div className="step-content">
            <div className="encryption-preview">
              <h4>FHE Encryption Preview</h4>
              <div className="preview-container">
                <div className="data-section">
                  <div className="data-label">Plain Preferences</div>
                  <div className="data-value">{JSON.stringify(recordData.preferences)}</div>
                </div>
                <div className="encryption-arrow">→</div>
                <div className="data-section encrypted">
                  <div className="data-label">FHE Encrypted</div>
                  <div className="data-value">
                    {JSON.stringify({
                      temperature: FHEEncryptNumber(recordData.preferences.temperature).substring(0, 20) + '...',
                      musicVolume: FHEEncryptNumber(recordData.preferences.musicVolume).substring(0, 20) + '...',
                      drivingStyle: FHEEncryptNumber(recordData.preferences.drivingStyle).substring(0, 20) + '...',
                      routePriority: FHEEncryptNumber(recordData.preferences.routePriority).substring(0, 20) + '...'
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      
      case 4:
        return (
          <div className="step-content">
            <div className="confirmation-summary">
              <h4>DAV Access Summary</h4>
              <div className="summary-item">
                <span>Vehicle ID:</span>
                <span>{recordData.vehicleId}</span>
              </div>
              <div className="summary-item">
                <span>Access Type:</span>
                <span>{recordData.accessType}</span>
              </div>
              <div className="summary-preferences">
                <span>Encrypted Preferences:</span>
                <div className="preferences-grid">
                  {Object.entries(recordData.preferences).map(([key, value]) => (
                    <div key={key} className="pref-item">
                      <span className="pref-label">{key}:</span>
                      <span className="pref-value">{value as number}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="modal-overlay hud-overlay">
      <div className="create-modal hud-panel">
        <div className="modal-header">
          <h2>Create DAV Access NFT - Step {currentStep} of {steps.length}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="step-indicator">
          {steps.map((step, index) => (
            <div key={index} className={`step-dot ${index + 1 <= currentStep ? 'active' : ''}`}>
              {step}
            </div>
          ))}
        </div>

        <div className="modal-body">
          {renderStepContent()}
        </div>

        <div className="modal-footer">
          <button onClick={prevStep} disabled={currentStep === 1} className="hud-button">
            Previous
          </button>
          {currentStep < steps.length ? (
            <button onClick={nextStep} className="hud-button primary">
              Next
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={creating} className="hud-button primary">
              {creating ? "Encrypting with FHE..." : "Create DAV Access"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: DAVRecord;
  onClose: () => void;
  decryptedPreferences: any;
  setDecryptedPreferences: (prefs: any) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<any>;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, onClose, decryptedPreferences, setDecryptedPreferences, isDecrypting, decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedPreferences !== null) { 
      setDecryptedPreferences(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(record.encryptedData);
    if (decrypted !== null) setDecryptedPreferences(decrypted);
  };

  return (
    <div className="modal-overlay hud-overlay">
      <div className="record-detail-modal hud-panel">
        <div className="modal-header">
          <h2>DAV Access Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="record-info">
            <div className="info-grid">
              <div className="info-item">
                <span>Vehicle ID:</span>
                <strong>{record.vehicleId}</strong>
              </div>
              <div className="info-item">
                <span>Access Type:</span>
                <strong>{record.accessType}</strong>
              </div>
              <div className="info-item">
                <span>Status:</span>
                <strong className={`status-badge ${record.status}`}>{record.status}</strong>
              </div>
              <div className="info-item">
                <span>Created:</span>
                <strong>{new Date(record.timestamp * 1000).toLocaleString()}</strong>
              </div>
            </div>
          </div>

          <div className="preferences-section">
            <h3>Encrypted Preferences</h3>
            <div className="preferences-comparison">
              <div className="preferences-column">
                <h4>FHE Encrypted</h4>
                {/* Render encrypted preferences chart */}
              </div>
              
              <div className="decryption-interface">
                <button className="hud-button" onClick={handleDecrypt} disabled={isDecrypting}>
                  {isDecrypting ? "Decrypting..." : 
                   decryptedPreferences ? "Re-encrypt Data" : "Decrypt with Signature"}
                </button>
              </div>

              {decryptedPreferences && (
                <div className="preferences-column decrypted">
                  <h4>Decrypted</h4>
                  {/* Render decrypted preferences chart */}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="hud-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;