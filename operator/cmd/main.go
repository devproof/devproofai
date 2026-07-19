// Devproof operator entry point. Runs in- or out-of-cluster (kubeconfig).
package main

import (
	"os"
	"time"

	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1alpha1 "github.com/devproof/devproof/operator/api/v1alpha1"
	"github.com/devproof/devproof/operator/internal/controller"
	"github.com/devproof/devproof/operator/internal/transform"
	"github.com/devproof/devproof/operator/internal/scaler"
)

// Overridden at build time: -ldflags "-X main.version=<git describe>".
var version = "dev"

func main() {
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))
	setupLog := ctrl.Log.WithName("setup")
	setupLog.Info("devproof operator", "version", version)

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		setupLog.Error(err, "add client-go scheme")
		os.Exit(1)
	}
	if err := v1alpha1.AddToScheme(scheme); err != nil {
		setupLog.Error(err, "add devproof scheme")
		os.Exit(1)
	}

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:  scheme,
		Metrics: metricsserver.Options{BindAddress: "0"}, // no metrics endpoint yet
	})
	if err != nil {
		setupLog.Error(err, "create manager")
		os.Exit(1)
	}

	if err := (&controller.ModelDeploymentReconciler{
		Client: mgr.GetClient(),
		// Devproof mirrors of the llama.cpp engine images (chart operator.engineImage);
		// unset = LLMkube upstream default.
		EngineImages: transform.EngineImages{
			CPU:        os.Getenv("DEVPROOF_ENGINE_IMAGE"),
			GPU:        os.Getenv("DEVPROOF_ENGINE_IMAGE_GPU"),
			PullSecret: os.Getenv("DEVPROOF_IMAGE_PULL_SECRET"),
		},
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "setup ModelDeployment controller")
		os.Exit(1)
	}

	clientset, err := kubernetes.NewForConfig(mgr.GetConfig())
	if err != nil {
		setupLog.Error(err, "create clientset")
		os.Exit(1)
	}
	if err := mgr.Add(&scaler.Scaler{
		Client: mgr.GetClient(), Clientset: clientset, Interval: 15 * time.Second,
	}); err != nil {
		setupLog.Error(err, "add scaler")
		os.Exit(1)
	}

	setupLog.Info("starting devproof operator")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "manager exited")
		os.Exit(1)
	}
}
