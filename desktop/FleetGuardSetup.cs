using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using Ellipse = System.Windows.Shapes.Ellipse;

namespace FleetGuardSetup
{
    public enum AuthKind
    {
        None,
        Claude,
        Codex,
        Cursor,
        FirstRun,
        Copilot
    }

    public sealed class ProviderInfo
    {
        public string Id;
        public string Name { get; set; }
        public string Monogram;
        public string Description;
        public string Command;
        public string AlternateCommand;
        public string VersionArguments;
        public string OfficialUrl;
        public string SignInCommand;
        public bool Required;
        public bool Installed;
        public bool Authenticated;
        public bool AuthKnown;
        public bool VerificationSupported;
        public bool VerificationRunning;
        public bool LiveVerified;
        public bool VerificationFailed;
        public string VerificationDetail;
        public bool Selected;
        public string Version;
        public string ResolvedCommand;
        public string StatusText;
        public AuthKind AuthKind;
        public ProviderRow Row;

        public bool CanUse
        {
            get { return Installed && (!AuthKnown || Authenticated); }
        }
    }

    public sealed class PolicyOption
    {
        public string Name { get; set; }
        public string Value { get; set; }
        public int Number { get; set; }
    }

    public sealed class SavedWorker
    {
        public string id { get; set; }
        public string provider { get; set; }
    }

    public sealed class SavedLocalModel
    {
        public string endpoint { get; set; }
        public string model { get; set; }
    }

    public sealed class SavedContinuationPolicy
    {
        public string mode { get; set; }
        public int sameAgentNudges { get; set; }
        public bool verifyCompletion { get; set; }
        public bool reuseSessions { get; set; }
        public int retryDelayMinutes { get; set; }
    }

    public sealed class SavedGuardConfig
    {
        public List<SavedWorker> fallbackOrder { get; set; }
        public SavedContinuationPolicy continuationPolicy { get; set; }
        public SavedLocalModel localModel { get; set; }
    }

    public sealed class ProviderRow : Border
    {
        private readonly ProviderInfo provider;
        private readonly TextBlock status;
        private readonly Border statusPill;
        private readonly Button getButton;
        private readonly Button signInButton;
        private readonly Button verifyButton;
        private readonly CheckBox includeBox;

        public event Action<ProviderInfo> GetClicked;
        public event Action<ProviderInfo> SignInClicked;
        public event Action<ProviderInfo> VerifyClicked;
        public event Action<ProviderInfo> SelectionChanged;

        public ProviderRow(ProviderInfo value)
        {
            provider = value;
            CornerRadius = new CornerRadius(17);
            BorderBrush = BrushFrom("#E5E8EF");
            BorderThickness = new Thickness(1);
            Background = BrushFrom("#F9FAFC");
            Padding = new Thickness(16, 13, 14, 13);
            Margin = new Thickness(0, 0, 0, 9);

            Grid grid = new Grid();
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(44) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Child = grid;

            Border mark = new Border
            {
                Width = 36,
                Height = 36,
                CornerRadius = new CornerRadius(11),
                Background = BrushFrom(MonogramColor(provider.Id)),
                VerticalAlignment = VerticalAlignment.Center
            };
            mark.Child = new TextBlock
            {
                Text = provider.Monogram,
                Foreground = Brushes.White,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(mark, 0);
            grid.Children.Add(mark);

            StackPanel copy = new StackPanel { Margin = new Thickness(10, 0, 15, 0), VerticalAlignment = VerticalAlignment.Center };
            StackPanel titleLine = new StackPanel { Orientation = Orientation.Horizontal };
            titleLine.Children.Add(new TextBlock
            {
                Text = provider.Name,
                FontSize = 14,
                FontWeight = FontWeights.SemiBold,
                Foreground = BrushFrom("#14171F"),
                VerticalAlignment = VerticalAlignment.Center
            });
            if (provider.Required)
            {
                Border required = new Border
                {
                    Margin = new Thickness(8, 0, 0, 0),
                    Padding = new Thickness(7, 2, 7, 2),
                    CornerRadius = new CornerRadius(7),
                    Background = BrushFrom("#EBF2FF"),
                    Child = new TextBlock { Text = "REQUIRED", FontSize = 9, FontWeight = FontWeights.Bold, Foreground = BrushFrom("#3168D8") }
                };
                titleLine.Children.Add(required);
            }
            copy.Children.Add(titleLine);
            copy.Children.Add(new TextBlock
            {
                Text = provider.Description,
                Margin = new Thickness(0, 3, 0, 0),
                FontSize = 11.5,
                Foreground = BrushFrom("#6E7480"),
                TextTrimming = TextTrimming.CharacterEllipsis
            });
            Grid.SetColumn(copy, 1);
            grid.Children.Add(copy);

            StackPanel controls = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            status = new TextBlock { FontSize = 10.5, FontWeight = FontWeights.SemiBold };
            statusPill = new Border
            {
                CornerRadius = new CornerRadius(9),
                Padding = new Thickness(9, 5, 9, 5),
                Margin = new Thickness(0, 0, 8, 0),
                Child = status
            };
            controls.Children.Add(statusPill);

            getButton = SmallButton(provider.Id == "local" ? "Configure" : "Get");
            getButton.Margin = new Thickness(0, 0, 6, 0);
            getButton.Click += delegate { if (GetClicked != null) GetClicked(provider); };
            controls.Children.Add(getButton);

            signInButton = SmallButton("Sign in");
            signInButton.Margin = new Thickness(0, 0, 8, 0);
            signInButton.Click += delegate { if (SignInClicked != null) SignInClicked(provider); };
            controls.Children.Add(signInButton);

            verifyButton = SmallButton("Verify");
            verifyButton.Margin = new Thickness(0, 0, 8, 0);
            verifyButton.ToolTip = "Send one short no-tools request. This uses provider quota; Antigravity may count a large fixed input context.";
            verifyButton.Click += delegate { if (VerifyClicked != null) VerifyClicked(provider); };
            controls.Children.Add(verifyButton);

            includeBox = new CheckBox
            {
                VerticalAlignment = VerticalAlignment.Center,
                IsChecked = provider.Required || provider.Selected,
                IsEnabled = !provider.Required,
                ToolTip = provider.Required ? "Fleet Guard needs this component" : "Include this provider in the fallback chain"
            };
            includeBox.Checked += delegate { provider.Selected = true; if (SelectionChanged != null) SelectionChanged(provider); };
            includeBox.Unchecked += delegate { provider.Selected = false; if (SelectionChanged != null) SelectionChanged(provider); };
            controls.Children.Add(includeBox);
            Grid.SetColumn(controls, 2);
            grid.Children.Add(controls);

            ShowScanning();
        }

        public void ShowScanning()
        {
            status.Text = "Checking";
            status.Foreground = BrushFrom("#747B88");
            statusPill.Background = BrushFrom("#EEF0F4");
            getButton.Visibility = Visibility.Collapsed;
            signInButton.Visibility = Visibility.Collapsed;
            verifyButton.Visibility = Visibility.Collapsed;
            includeBox.IsEnabled = false;
        }

        public void ShowWorking(string text)
        {
            status.Text = text;
            status.Foreground = BrushFrom("#5265C4");
            statusPill.Background = BrushFrom("#EDF0FF");
            getButton.Visibility = Visibility.Visible;
            signInButton.Visibility = Visibility.Collapsed;
            verifyButton.Visibility = Visibility.Collapsed;
            includeBox.IsEnabled = false;
        }

        public void Refresh()
        {
            if (provider.Id == "local")
            {
                status.ToolTip = String.IsNullOrWhiteSpace(provider.VerificationDetail) ? null : provider.VerificationDetail;
                getButton.Content = "Configure";
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = Visibility.Collapsed;
                if (!provider.Installed)
                {
                    status.Text = "Needs OpenCode";
                    status.Foreground = BrushFrom("#B44E28");
                    statusPill.Background = BrushFrom("#FFF0E9");
                    includeBox.IsChecked = false;
                    includeBox.IsEnabled = false;
                    return;
                }
                if (!provider.Authenticated)
                {
                    status.Text = String.IsNullOrWhiteSpace(provider.VerificationDetail) ? "Choose a model" : "Local server unavailable";
                    status.Foreground = BrushFrom("#9B6717");
                    statusPill.Background = BrushFrom("#FFF5D9");
                    includeBox.IsChecked = false;
                    includeBox.IsEnabled = false;
                    return;
                }
                status.Text = String.IsNullOrWhiteSpace(provider.Version) ? "Local model ready" : provider.Version;
                status.Foreground = BrushFrom("#26724E");
                statusPill.Background = BrushFrom("#E8F7EF");
                includeBox.IsEnabled = true;
                includeBox.IsChecked = provider.Selected;
                return;
            }

            if (!provider.Installed)
            {
                status.Text = "Not found";
                status.Foreground = BrushFrom("#B44E28");
                statusPill.Background = BrushFrom("#FFF0E9");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = Visibility.Collapsed;
                includeBox.IsChecked = provider.Required;
                includeBox.IsEnabled = false;
                return;
            }

            if (provider.VerificationRunning)
            {
                status.Text = "Verifying...";
                status.Foreground = BrushFrom("#5265C4");
                statusPill.Background = BrushFrom("#EDF0FF");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = Visibility.Collapsed;
                includeBox.IsEnabled = false;
                return;
            }

            if (provider.VerificationFailed)
            {
                status.Text = "Could not verify";
                status.ToolTip = provider.VerificationDetail;
                status.Foreground = BrushFrom("#9B6717");
                statusPill.Background = BrushFrom("#FFF5D9");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Visible;
                verifyButton.Visibility = provider.VerificationSupported ? Visibility.Visible : Visibility.Collapsed;
                includeBox.IsEnabled = !provider.Required && provider.Authenticated;
                includeBox.IsChecked = provider.Required || provider.Selected;
                return;
            }

            if (provider.AuthKnown && !provider.Authenticated)
            {
                status.Text = "Sign-in needed";
                status.Foreground = BrushFrom("#9B6717");
                statusPill.Background = BrushFrom("#FFF5D9");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Visible;
                verifyButton.Visibility = provider.VerificationSupported ? Visibility.Visible : Visibility.Collapsed;
                includeBox.IsChecked = provider.Required;
                includeBox.IsEnabled = false;
                return;
            }

            if (provider.LiveVerified)
            {
                status.Text = "Live test passed";
                status.Foreground = BrushFrom("#26724E");
                statusPill.Background = BrushFrom("#E8F7EF");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = provider.VerificationSupported ? Visibility.Visible : Visibility.Collapsed;
            }
            else if (provider.VerificationSupported && provider.Authenticated)
            {
                status.Text = "Signed in";
                status.Foreground = BrushFrom("#26724E");
                statusPill.Background = BrushFrom("#E8F7EF");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = Visibility.Visible;
            }
            else
            {
                status.Text = String.IsNullOrWhiteSpace(provider.Version) ? "Ready" : provider.Version;
                status.Foreground = BrushFrom("#26724E");
                statusPill.Background = BrushFrom("#E8F7EF");
                getButton.Visibility = Visibility.Visible;
                signInButton.Visibility = Visibility.Collapsed;
                verifyButton.Visibility = provider.VerificationSupported ? Visibility.Visible : Visibility.Collapsed;
            }

            includeBox.IsEnabled = !provider.Required;
            if (provider.Required) includeBox.IsChecked = true;
            else includeBox.IsChecked = provider.Selected;
        }

        private static Button SmallButton(string text)
        {
            Button button = new Button
            {
                Content = text,
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                Foreground = BrushFrom("#3B424D"),
                Background = Brushes.White,
                BorderBrush = BrushFrom("#DDE1E8"),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(10, 5, 10, 5),
                Cursor = Cursors.Hand
            };
            return button;
        }

        private static string MonogramColor(string id)
        {
            if (id == "paseo") return "#5F70E8";
            if (id == "node") return "#5C9A58";
            if (id == "claude") return "#B56B46";
            if (id == "codex") return "#24272D";
            if (id == "antigravity") return "#4285F4";
            if (id == "cursor") return "#40404A";
            if (id == "local") return "#7C5CE1";
            return "#5662A8";
        }

        private static SolidColorBrush BrushFrom(string value)
        {
            return (SolidColorBrush)new BrushConverter().ConvertFromString(value);
        }
    }

    public sealed class MainWindow : Window
    {
        private readonly List<ProviderInfo> providers;
        private readonly Grid contentHost;
        private readonly TextBlock eyebrow;
        private readonly TextBlock pageTitle;
        private readonly TextBlock pageSubtitle;
        private readonly StackPanel body;
        private readonly Button backButton;
        private readonly Button nextButton;
        private readonly TextBlock footerNote;
        private readonly List<TextBlock> navLabels;
        private readonly List<Ellipse> navDots;
        private readonly ListBox chainList;
        private readonly TextBlock chainWarning;
        private readonly ProgressBar installProgress;
        private readonly TextBlock installStatus;
        private readonly ComboBox continuationModeBox;
        private readonly ComboBox nudgeCountBox;
        private readonly ComboBox retryDelayBox;
        private readonly CheckBox verifyCompletionBox;
        private readonly CheckBox reuseSessionsBox;
        private readonly Border continuationPolicyCard;
        private readonly List<string> preferredProviderOrder;
        private bool hasExistingGuardConfig;
        private int currentStep;
        private bool scanning;
        private bool hasScanned;
        private bool installing;
        private string installedGuidePath;
        private string localEndpoint;
        private string localModel;

        private static SolidColorBrush B(string value)
        {
            return (SolidColorBrush)new BrushConverter().ConvertFromString(value);
        }

        public MainWindow()
        {
            Title = "Fleet Guard Setup";
            Width = 1060;
            Height = 760;
            MinWidth = 940;
            MinHeight = 680;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.CanResizeWithGrip;
            FontFamily = new FontFamily("Segoe UI");

            localEndpoint = "http://127.0.0.1:11434/v1";
            localModel = "";
            providers = CreateProviders();
            navLabels = new List<TextBlock>();
            navDots = new List<Ellipse>();
            chainList = new ListBox();
            chainWarning = new TextBlock();
            installProgress = new ProgressBar();
            installStatus = new TextBlock();
            preferredProviderOrder = new List<string>();
            continuationModeBox = ChoiceBox(new []
            {
                new PolicyOption { Name="Return to Claude", Value="return-to-source" },
                new PolicyOption { Name="Cycle fallback providers", Value="cycle" },
                new PolicyOption { Name="One pass, then stop", Value="single-pass" }
            }, 0);
            nudgeCountBox = ChoiceBox(new []
            {
                new PolicyOption { Name="Once", Number=1 },
                new PolicyOption { Name="Twice", Number=2 },
                new PolicyOption { Name="Do not nudge", Number=0 },
                new PolicyOption { Name="Three times", Number=3 }
            }, 0);
            retryDelayBox = ChoiceBox(new []
            {
                new PolicyOption { Name="15 minutes", Number=15 },
                new PolicyOption { Name="5 minutes", Number=5 },
                new PolicyOption { Name="30 minutes", Number=30 },
                new PolicyOption { Name="60 minutes", Number=60 }
            }, 0);
            verifyCompletionBox = new CheckBox { Content="Challenge a completion claim once", IsChecked=true, FontSize=10.5, Foreground=B("#4F5764") };
            reuseSessionsBox = new CheckBox { Content="Return to the same child agents on later cycles", IsChecked=true, FontSize=10.5, Foreground=B("#4F5764"), Margin=new Thickness(0, 7, 0, 0) };
            continuationPolicyCard = BuildContinuationPolicyCard();
            LoadExistingConfiguration();

            Border shell = new Border
            {
                Margin = new Thickness(18),
                CornerRadius = new CornerRadius(28),
                Background = B("#F8FAFDF5"),
                BorderBrush = B("#D7DBE5"),
                BorderThickness = new Thickness(1),
                Effect = new DropShadowEffect { BlurRadius = 34, ShadowDepth = 9, Opacity = 0.24, Color = Color.FromRgb(35, 43, 58) }
            };
            Grid outer = new Grid();
            outer.RowDefinitions.Add(new RowDefinition { Height = new GridLength(58) });
            outer.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            shell.Child = outer;
            Content = shell;

            Grid titleBar = BuildTitleBar();
            Grid.SetRow(titleBar, 0);
            outer.Children.Add(titleBar);

            Grid main = new Grid();
            main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(238) });
            main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetRow(main, 1);
            outer.Children.Add(main);

            Border sidebar = BuildSidebar();
            Grid.SetColumn(sidebar, 0);
            main.Children.Add(sidebar);

            contentHost = new Grid { Margin = new Thickness(44, 28, 44, 31) };
            contentHost.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            contentHost.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            contentHost.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            Grid.SetColumn(contentHost, 1);
            main.Children.Add(contentHost);

            StackPanel heading = new StackPanel { Margin = new Thickness(0, 0, 0, 18) };
            eyebrow = new TextBlock { FontSize = 10, FontWeight = FontWeights.Bold, Foreground = B("#6375DA") };
            pageTitle = new TextBlock { FontSize = 28, FontWeight = FontWeights.SemiBold, Foreground = B("#11141B"), Margin = new Thickness(0, 6, 0, 5) };
            pageSubtitle = new TextBlock { FontSize = 13, Foreground = B("#6B7280"), TextWrapping = TextWrapping.Wrap, MaxWidth = 690, HorizontalAlignment = HorizontalAlignment.Left };
            heading.Children.Add(eyebrow);
            heading.Children.Add(pageTitle);
            heading.Children.Add(pageSubtitle);
            Grid.SetRow(heading, 0);
            contentHost.Children.Add(heading);

            ScrollViewer scroller = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
            body = new StackPanel { Margin = new Thickness(0, 0, 8, 0) };
            scroller.Content = body;
            Grid.SetRow(scroller, 1);
            contentHost.Children.Add(scroller);

            Grid footer = new Grid { Margin = new Thickness(0, 20, 0, 0) };
            footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            footerNote = new TextBlock { FontSize = 10.5, Foreground = B("#8A909B"), VerticalAlignment = VerticalAlignment.Center };
            footer.Children.Add(footerNote);
            StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal };
            backButton = SecondaryButton("Back");
            backButton.Margin = new Thickness(0, 0, 9, 0);
            backButton.Click += delegate { Move(-1); };
            nextButton = PrimaryButton("Continue");
            nextButton.Click += delegate { OnNext(); };
            actions.Children.Add(backButton);
            actions.Children.Add(nextButton);
            Grid.SetColumn(actions, 1);
            footer.Children.Add(actions);
            Grid.SetRow(footer, 2);
            contentHost.Children.Add(footer);

            ShowStep(0);
        }

        private Grid BuildTitleBar()
        {
            Grid bar = new Grid { Background = Brushes.Transparent };
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            bar.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) DragMove(); };

            StackPanel brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(22, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            Border mark = new Border
            {
                Width = 29,
                Height = 29,
                CornerRadius = new CornerRadius(9),
                Background = new LinearGradientBrush(Color.FromRgb(87, 105, 229), Color.FromRgb(122, 86, 222), 45),
                Child = new TextBlock { Text = "F", Foreground = Brushes.White, FontSize = 13, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center }
            };
            brand.Children.Add(mark);
            brand.Children.Add(new TextBlock { Text = "Fleet Guard", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = B("#262A33"), Margin = new Thickness(9, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
            bar.Children.Add(brand);

            StackPanel chrome = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 14, 0) };
            Button min = ChromeButton("\u2013");
            min.Click += delegate { WindowState = WindowState.Minimized; };
            Button close = ChromeButton("\u00D7");
            close.Click += delegate { Close(); };
            chrome.Children.Add(min);
            chrome.Children.Add(close);
            Grid.SetColumn(chrome, 1);
            bar.Children.Add(chrome);
            return bar;
        }

        private Border BuildSidebar()
        {
            Border side = new Border
            {
                CornerRadius = new CornerRadius(0, 0, 0, 28),
                Background = B("#EFF2F7CC"),
                BorderBrush = B("#E0E4EB"),
                BorderThickness = new Thickness(0, 1, 1, 0),
                Padding = new Thickness(24, 32, 20, 24)
            };
            Grid grid = new Grid();
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            StackPanel nav = new StackPanel();
            string[] labels = { "Welcome", "Provider setup", "Fallback order", "Ready" };
            for (int i = 0; i < labels.Length; i++)
            {
                Grid row = new Grid { Height = 48 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(25) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                Ellipse dot = new Ellipse { Width = 8, Height = 8, Fill = B("#C7CBD4"), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Left };
                TextBlock label = new TextBlock { Text = labels[i], FontSize = 12.5, Foreground = B("#858B96"), VerticalAlignment = VerticalAlignment.Center };
                Grid.SetColumn(dot, 0);
                Grid.SetColumn(label, 1);
                row.Children.Add(dot);
                row.Children.Add(label);
                nav.Children.Add(row);
                navDots.Add(dot);
                navLabels.Add(label);
            }
            grid.Children.Add(nav);

            Border privacy = new Border
            {
                CornerRadius = new CornerRadius(15),
                Background = B("#FFFFFFA8"),
                BorderBrush = B("#E0E4EA"),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(13),
                Child = new TextBlock
                {
                    Text = "Private by design\n\nCredential-presence checks stay on this PC. Fleet Guard never reads, stores, or copies provider secrets.",
                    TextWrapping = TextWrapping.Wrap,
                    FontSize = 10.5,
                    LineHeight = 15,
                    Foreground = B("#69717D")
                }
            };
            Grid.SetRow(privacy, 1);
            grid.Children.Add(privacy);
            side.Child = grid;
            return side;
        }

        private static List<ProviderInfo> CreateProviders()
        {
            return new List<ProviderInfo>
            {
                new ProviderInfo { Id="paseo", Name="Paseo Desktop", Monogram="P", Description="The workspace where Fleet Guard watches Claude and starts a fallback.", Command="paseo", VersionArguments="--version", OfficialUrl="https://github.com/getpaseo/paseo/releases/latest", Required=true, Selected=true, AuthKind=AuthKind.None },
                new ProviderInfo { Id="node", Name="Node.js 22+", Monogram="N", Description="A small local runtime used to run Fleet Guard itself.", Command="node", VersionArguments="--version", OfficialUrl="https://nodejs.org/en/download", Required=true, Selected=true, AuthKind=AuthKind.None },
                new ProviderInfo { Id="claude", Name="Claude Code", Monogram="C", Description="The source provider Fleet Guard watches for a real quota or session-limit stop.", Command="claude", VersionArguments="--version", OfficialUrl="https://docs.anthropic.com/en/docs/claude-code/getting-started", SignInCommand="claude auth login", Required=true, Selected=true, AuthKind=AuthKind.Claude },
                new ProviderInfo { Id="codex", Name="OpenAI Codex", Monogram=">_", Description="Recommended first fallback; continues in the same Paseo workspace.", Command="codex", VersionArguments="--version", OfficialUrl="https://learn.chatgpt.com/docs/codex/cli", SignInCommand="codex login", Required=false, AuthKind=AuthKind.Codex },
                new ProviderInfo { Id="local", Name="Local model", Monogram="Lo", Description="A private same-PC model with real workspace tools through OpenCode; supports Ollama and compatible servers.", Command="opencode", VersionArguments="--version", OfficialUrl="https://opencode.ai/docs", Required=false, AuthKind=AuthKind.None },
                new ProviderInfo { Id="antigravity", Name="Google Antigravity", Monogram="A", Description="External CLI fallback; its progress is recorded in the handoff report, not a Paseo tab.", Command="agy", VersionArguments="--version", OfficialUrl="https://antigravity.google/docs/cli-install", SignInCommand="agy", Required=false, AuthKind=AuthKind.FirstRun, VerificationSupported=true },
                new ProviderInfo { Id="cursor", Name="Cursor Agent", Monogram="Cu", Description="Optional Paseo fallback configured to avoid repeated permission prompts.", Command="cursor-agent", AlternateCommand="agent", VersionArguments="--version", OfficialUrl="https://docs.cursor.com/en/cli/installation", SignInCommand="cursor-agent login", Required=false, AuthKind=AuthKind.Cursor },
                new ProviderInfo { Id="copilot", Name="GitHub Copilot CLI", Monogram="Gh", Description="Optional Paseo fallback using your GitHub Copilot account.", Command="copilot", VersionArguments="--version", OfficialUrl="https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli", SignInCommand="copilot login", Required=false, AuthKind=AuthKind.Copilot, VerificationSupported=true }
            };
        }

        private void LoadExistingConfiguration()
        {
            string configPath = Path.Combine(GuardStateHome(), "config.json");
            if (!File.Exists(configPath)) return;
            try
            {
                SavedGuardConfig saved = new JavaScriptSerializer().Deserialize<SavedGuardConfig>(File.ReadAllText(configPath));
                hasExistingGuardConfig = true;
                preferredProviderOrder.Clear();
                if (saved != null && saved.fallbackOrder != null)
                {
                    foreach (SavedWorker worker in saved.fallbackOrder)
                    {
                        if (worker != null && !String.IsNullOrWhiteSpace(worker.id) && !preferredProviderOrder.Contains(worker.id)) preferredProviderOrder.Add(worker.id);
                        if (worker != null && worker.id == "local" && String.IsNullOrWhiteSpace(localModel) && !String.IsNullOrWhiteSpace(worker.provider))
                        {
                            const string prefix = "fleet-local/fleet-local-api/";
                            if (worker.provider.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) localModel = worker.provider.Substring(prefix.Length);
                        }
                    }
                }
                if (saved != null && saved.localModel != null)
                {
                    if (!String.IsNullOrWhiteSpace(saved.localModel.endpoint)) localEndpoint = saved.localModel.endpoint;
                    if (!String.IsNullOrWhiteSpace(saved.localModel.model)) localModel = saved.localModel.model;
                }
                foreach (ProviderInfo provider in providers)
                {
                    if (!provider.Required) provider.Selected = preferredProviderOrder.Contains(provider.Id);
                }

                if (saved == null || saved.continuationPolicy == null)
                {
                    SelectChoice(continuationModeBox, "return-to-source", null);
                    SelectChoice(nudgeCountBox, null, 1);
                    verifyCompletionBox.IsChecked = true;
                    reuseSessionsBox.IsChecked = true;
                    return;
                }

                SavedContinuationPolicy policy = saved.continuationPolicy;
                SelectChoice(continuationModeBox, policy.mode, null);
                SelectChoice(nudgeCountBox, null, policy.sameAgentNudges);
                SelectChoice(retryDelayBox, null, policy.retryDelayMinutes);
                verifyCompletionBox.IsChecked = policy.verifyCompletion;
                reuseSessionsBox.IsChecked = policy.reuseSessions;
            }
            catch
            {
                hasExistingGuardConfig = false;
                preferredProviderOrder.Clear();
            }
        }

        private static void SelectChoice(ComboBox box, string value, int? number)
        {
            foreach (object item in box.Items)
            {
                PolicyOption option = item as PolicyOption;
                if (option == null) continue;
                if ((!String.IsNullOrWhiteSpace(value) && option.Value == value) || (number.HasValue && option.Number == number.Value))
                {
                    box.SelectedItem = option;
                    return;
                }
            }
        }

        private void ShowStep(int step)
        {
            currentStep = Math.Max(0, Math.Min(3, step));
            body.Children.Clear();
            for (int i = 0; i < navLabels.Count; i++)
            {
                bool active = i == currentStep;
                bool done = i < currentStep;
                navLabels[i].Foreground = active ? B("#1E2430") : done ? B("#5967B8") : B("#858B96");
                navLabels[i].FontWeight = active ? FontWeights.SemiBold : FontWeights.Normal;
                navDots[i].Fill = active ? B("#6677DE") : done ? B("#94A0E7") : B("#C7CBD4");
                navDots[i].Width = active ? 10 : 8;
                navDots[i].Height = active ? 10 : 8;
            }

            backButton.Visibility = currentStep == 0 || currentStep == 3 ? Visibility.Collapsed : Visibility.Visible;
            nextButton.IsEnabled = !installing;

            if (currentStep == 0) BuildWelcome();
            else if (currentStep == 1) BuildProviders();
            else if (currentStep == 2) BuildChain();
            else BuildReady();
        }

        private void BuildWelcome()
        {
            eyebrow.Text = "WELCOME";
            pageTitle.Text = "Keep long jobs moving.";
            pageSubtitle.Text = "Fleet Guard notices when a Claude task in Paseo stops at a genuine usage limit, then hands the unfinished work to the next provider you choose.";
            nextButton.Content = "Set up providers";
            footerNote.Text = "Windows 10 or 11  \u2022  no admin access required";

            Border hero = GlassCard();
            Grid grid = new Grid { Margin = new Thickness(4) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(235) });
            StackPanel left = new StackPanel { Margin = new Thickness(6, 4, 26, 4) };
            left.Children.Add(new TextBlock { Text = "What it does", FontSize = 11, FontWeight = FontWeights.Bold, Foreground = B("#6677D7") });
            left.Children.Add(new TextBlock { Text = "One watcher. Your providers.", FontSize = 22, FontWeight = FontWeights.SemiBold, Foreground = B("#151820"), Margin = new Thickness(0, 10, 0, 16) });
            left.Children.Add(Feature("Listens only to root Claude tasks opened in Paseo."));
            left.Children.Add(Feature("Triggers only after the timeline records a quota/session-limit failure."));
            left.Children.Add(Feature("Creates a child task with recent context and verifies completion."));
            left.Children.Add(Feature("Exits completely after the Paseo daemon is gone for 20 seconds."));
            grid.Children.Add(left);

            Border diagram = new Border { CornerRadius = new CornerRadius(20), Background = new LinearGradientBrush(Color.FromRgb(239, 242, 253), Color.FromRgb(245, 240, 253), 90), Padding = new Thickness(22) };
            StackPanel flow = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            flow.Children.Add(FlowNode("Claude", "usage limit recorded", "#B76F4C"));
            flow.Children.Add(new TextBlock { Text = "\u2193", FontSize = 18, Foreground = B("#9299AA"), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) });
            flow.Children.Add(FlowNode("Fleet Guard", "packages the handoff", "#6576DE"));
            flow.Children.Add(new TextBlock { Text = "\u2193", FontSize = 18, Foreground = B("#9299AA"), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) });
            flow.Children.Add(FlowNode("Next provider", "continues the job", "#38825F"));
            diagram.Child = flow;
            Grid.SetColumn(diagram, 1);
            grid.Children.Add(diagram);
            hero.Child = grid;
            body.Children.Add(hero);

            TextBlock note = new TextBlock
            {
                Text = "Fleet Guard does not bypass, reset, or extend any provider limit. Each fallback uses that provider's own installed CLI, account, subscription, permissions, and quota.",
                TextWrapping = TextWrapping.Wrap,
                Foreground = B("#777E89"),
                FontSize = 11,
                LineHeight = 17,
                Margin = new Thickness(8, 16, 8, 0)
            };
            body.Children.Add(note);
        }

        private void BuildProviders()
        {
            eyebrow.Text = "STEP 1 OF 2";
            pageTitle.Text = "Connect your providers.";
            pageSubtitle.Text = "Install as many fallbacks as you want. Cloud sign-in stays with each CLI; a local model can be connected through OpenCode without an account.";
            nextButton.Content = "Choose fallback order";
            footerNote.Text = "Only the optional Verify button contacts a provider";

            Grid toolbar = new Grid { Margin = new Thickness(0, 0, 0, 12) };
            toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            TextBlock guidance = new TextBlock { Text = "Available on this PC", FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = B("#3B414C"), VerticalAlignment = VerticalAlignment.Center };
            toolbar.Children.Add(guidance);
            Button scan = SecondaryButton(scanning ? "Checking..." : "Re-scan");
            scan.IsEnabled = !scanning;
            scan.Click += delegate { ScanProviders(); };
            Grid.SetColumn(scan, 1);
            toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            toolbar.Children.Add(scan);
            body.Children.Add(toolbar);

            foreach (ProviderInfo provider in providers)
            {
                ProviderRow row = new ProviderRow(provider);
                provider.Row = row;
                row.GetClicked += delegate(ProviderInfo p) { if (p.Id == "local") ConfigureLocalModel(p); else OpenUrl(p.OfficialUrl); };
                row.SignInClicked += delegate(ProviderInfo p) { if (p.Id == "local") ConfigureLocalModel(p); else LaunchSignIn(p); };
                row.VerifyClicked += delegate(ProviderInfo p) { VerifyProvider(p); };
                row.SelectionChanged += delegate { };
                if (hasScanned) row.Refresh();
                body.Children.Add(row);
            }
            if (!hasScanned && !scanning) ScanProviders();
        }

        private void BuildChain()
        {
            eyebrow.Text = "STEP 2 OF 2";
            pageTitle.Text = "Set the fallback order.";
            pageSubtitle.Text = "Order is priority. Choose whether Guard stops after one pass, cycles the same agents, or returns the shared work to the original Claude task.";
            nextButton.Content = "Install Fleet Guard";
            footerNote.Text = "Installed to your Windows account only";

            Border source = new Border { CornerRadius = new CornerRadius(16), Background = B("#F6EEE9"), BorderBrush = B("#E8D8CF"), BorderThickness = new Thickness(1), Padding = new Thickness(16, 12, 16, 12) };
            Grid sourceGrid = new Grid();
            sourceGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            sourceGrid.Children.Add(new TextBlock { Text = "Claude Code", FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = B("#3E302A") });
            TextBlock watched = new TextBlock { Text = "WATCHED SOURCE", FontSize = 9.5, FontWeight = FontWeights.Bold, Foreground = B("#9A6247"), VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(watched, 1);
            sourceGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            sourceGrid.Children.Add(watched);
            source.Child = sourceGrid;
            body.Children.Add(source);
            body.Children.Add(new TextBlock { Text = "\u2193", FontSize = 17, Foreground = B("#A4A9B3"), Margin = new Thickness(20, 6, 0, 6) });

            List<ProviderInfo> selected = providers.Where(delegate(ProviderInfo p) { return !p.Required && p.Selected && p.Installed; })
                .OrderBy(delegate(ProviderInfo p)
                {
                    int configuredIndex = preferredProviderOrder.IndexOf(p.Id);
                    return configuredIndex >= 0 ? configuredIndex : 1000 + providers.IndexOf(p);
                }).ToList();
            chainList.Items.Clear();
            foreach (ProviderInfo provider in selected) chainList.Items.Add(provider);
            chainList.DisplayMemberPath = "Name";
            chainList.BorderBrush = B("#E1E5EB");
            chainList.Background = B("#FBFCFE");
            chainList.MinHeight = 115;
            chainList.MaxHeight = 145;
            chainList.FontSize = 13;
            chainList.Padding = new Thickness(8);
            body.Children.Add(chainList);

            StackPanel reorder = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 9, 0, 0) };
            Button up = SecondaryButton("Move up");
            up.Margin = new Thickness(0, 0, 7, 0);
            up.Click += delegate { MoveSelectedProvider(-1); };
            Button down = SecondaryButton("Move down");
            down.Click += delegate { MoveSelectedProvider(1); };
            reorder.Children.Add(up);
            reorder.Children.Add(down);
            body.Children.Add(reorder);

            chainWarning.Text = selected.Count == 0
                ? "Choose at least one installed fallback on the previous page."
                : "The first available provider starts immediately after a confirmed Claude limit.";
            chainWarning.Foreground = selected.Count == 0 ? B("#AD552D") : B("#6F7681");
            chainWarning.FontSize = 11;
            chainWarning.Margin = new Thickness(4, 14, 0, 0);
            body.Children.Add(chainWarning);
            nextButton.IsEnabled = selected.Count > 0 && RequiredReady();

            body.Children.Add(continuationPolicyCard);

            Border safety = new Border { CornerRadius = new CornerRadius(14), Background = B("#EEF4FF"), Padding = new Thickness(14), Margin = new Thickness(0, 10, 0, 0) };
            safety.Child = new TextBlock
            {
                Text = "Same-agent nudges reuse the visible Paseo child (or Antigravity conversation). Local models run through OpenCode with the same workspace tools. A completion challenge asks the agent to inspect and test once more before Guard accepts complete.",
                TextWrapping = TextWrapping.Wrap,
                Foreground = B("#53617C"),
                FontSize = 10.5,
                LineHeight = 16
            };
            body.Children.Add(safety);
        }

        private Border BuildContinuationPolicyCard()
        {
            Border card = new Border
            {
                CornerRadius = new CornerRadius(15),
                Background = B("#FBFCFE"),
                BorderBrush = B("#E1E5EC"),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(14),
                Margin = new Thickness(0, 14, 0, 0)
            };
            StackPanel panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text="Continuation policy", FontSize=12, FontWeight=FontWeights.SemiBold, Foreground=B("#252A34") });
            panel.Children.Add(new TextBlock
            {
                Text="The first provider is highest priority. Persistent modes keep cycling only while Paseo is running.",
                FontSize=10.25,
                Foreground=B("#747B87"),
                Margin=new Thickness(0, 3, 0, 10),
                TextWrapping=TextWrapping.Wrap
            });

            Grid choices = new Grid();
            choices.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            choices.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            choices.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            StackPanel mode = PolicyField("After the list ends", continuationModeBox);
            StackPanel nudges = PolicyField("Nudge an unfinished agent", nudgeCountBox);
            StackPanel delay = PolicyField("Before another cycle", retryDelayBox);
            Grid.SetColumn(mode, 0);
            Grid.SetColumn(nudges, 1);
            Grid.SetColumn(delay, 2);
            mode.Margin = new Thickness(0, 0, 8, 0);
            nudges.Margin = new Thickness(4, 0, 4, 0);
            delay.Margin = new Thickness(8, 0, 0, 0);
            choices.Children.Add(mode);
            choices.Children.Add(nudges);
            choices.Children.Add(delay);
            panel.Children.Add(choices);

            StackPanel checks = new StackPanel { Orientation=Orientation.Horizontal, Margin=new Thickness(0, 11, 0, 0) };
            reuseSessionsBox.Margin = new Thickness(0, 0, 25, 0);
            checks.Children.Add(reuseSessionsBox);
            checks.Children.Add(verifyCompletionBox);
            panel.Children.Add(checks);
            card.Child = panel;
            return card;
        }

        private static StackPanel PolicyField(string label, Control control)
        {
            StackPanel field = new StackPanel();
            field.Children.Add(new TextBlock { Text=label, FontSize=9.75, FontWeight=FontWeights.SemiBold, Foreground=B("#626A77"), Margin=new Thickness(0, 0, 0, 5) });
            field.Children.Add(control);
            return field;
        }

        private void BuildReady()
        {
            eyebrow.Text = "ALL SET";
            pageTitle.Text = "Fleet Guard is ready.";
            pageSubtitle.Text = "Use the combined shortcut from now on. If Paseo was open during setup, fully quit it once first so Fleet Guard's provider profiles are loaded.";
            nextButton.Content = "Open usage guide";
            nextButton.IsEnabled = true;
            footerNote.Text = "No Windows-login task was created";

            Border success = GlassCard();
            StackPanel panel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(26, 20, 26, 20), MaxWidth = 540 };
            Border check = new Border { Width = 56, Height = 56, CornerRadius = new CornerRadius(18), Background = B("#E5F6ED"), Child = new TextBlock { Text = "\u2713", FontSize = 26, FontWeight = FontWeights.SemiBold, Foreground = B("#2B7B56"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
            panel.Children.Add(check);
            panel.Children.Add(new TextBlock { Text = "Launch Fleet Supervisor - On Paseo", FontSize = 21, FontWeight = FontWeights.SemiBold, Foreground = B("#171A21"), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 17, 0, 7) });
            panel.Children.Add(new TextBlock { Text = "You'll find it on the Desktop and in the Start Menu. Use Fleet Guard Settings in the Start Menu whenever you want to change the policy.", FontSize = 12.5, Foreground = B("#727985"), HorizontalAlignment = HorizontalAlignment.Center, TextAlignment=TextAlignment.Center, TextWrapping=TextWrapping.Wrap });

            Border how = new Border { CornerRadius = new CornerRadius(14), Background = B("#F3F5F9"), Padding = new Thickness(15), Margin = new Thickness(0, 22, 0, 0) };
            how.Child = new TextBlock
            {
                Text = "For a task that already stopped: leave it in Paseo and launch the combined shortcut. Fleet Guard scans recent root Claude tasks automatically. No re-prompt is needed. Conversations outside Paseo must be imported into Paseo first.",
                TextWrapping = TextWrapping.Wrap,
                TextAlignment = TextAlignment.Center,
                FontSize = 11,
                LineHeight = 17,
                Foreground = B("#5E6673")
            };
            panel.Children.Add(how);
            success.Child = panel;
            body.Children.Add(success);
        }

        private void OnNext()
        {
            if (currentStep == 0) ShowStep(1);
            else if (currentStep == 1)
            {
                if (!RequiredReady())
                {
                    MessageBox.Show(this, "Paseo Desktop, Node.js 22+, and a signed-in Claude Code installation are required before continuing.", "A few essentials are missing", MessageBoxButton.OK, MessageBoxImage.Information);
                    return;
                }
                ShowStep(2);
            }
            else if (currentStep == 2) InstallGuard();
            else
            {
                if (!String.IsNullOrWhiteSpace(installedGuidePath) && File.Exists(installedGuidePath)) Process.Start(new ProcessStartInfo(installedGuidePath) { UseShellExecute = true });
            }
        }

        private void Move(int delta)
        {
            if (installing) return;
            ShowStep(currentStep + delta);
        }

        private void MoveSelectedProvider(int delta)
        {
            int index = chainList.SelectedIndex;
            if (index < 0) return;
            int target = index + delta;
            if (target < 0 || target >= chainList.Items.Count) return;
            object item = chainList.Items[index];
            chainList.Items.RemoveAt(index);
            chainList.Items.Insert(target, item);
            chainList.SelectedIndex = target;
            preferredProviderOrder.Clear();
            foreach (ProviderInfo provider in chainList.Items.Cast<ProviderInfo>()) preferredProviderOrder.Add(provider.Id);
        }

        private bool RequiredReady()
        {
            return providers.Where(delegate(ProviderInfo p) { return p.Required; }).All(delegate(ProviderInfo p) { return p.CanUse; });
        }

        private void ScanProviders()
        {
            if (scanning) return;
            scanning = true;
            bool preserveSelections = hasScanned;
            foreach (ProviderInfo p in providers) if (p.Row != null) p.Row.ShowScanning();
            nextButton.IsEnabled = false;
            RefreshPath();

            Task.Run(delegate
            {
                foreach (ProviderInfo provider in providers) InspectProvider(provider, preserveSelections);
            }).ContinueWith(delegate
            {
                Dispatcher.Invoke(delegate
                {
                    scanning = false;
                    hasScanned = true;
                    foreach (ProviderInfo p in providers) if (p.Row != null) p.Row.Refresh();
                    nextButton.IsEnabled = true;
                    ShowStep(1);
                });
            });
        }

        private void InspectProvider(ProviderInfo provider, bool preserveSelection)
        {
            bool keepLiveVerification = provider.LiveVerified;
            provider.Installed = false;
            provider.Authenticated = false;
            provider.AuthKnown = false;
            provider.VerificationRunning = false;
            provider.VerificationFailed = false;
            provider.VerificationDetail = "";
            provider.Version = "";
            provider.ResolvedCommand = "";

            if (provider.Id == "paseo")
            {
                string desktop = FindPaseoDesktop();
                provider.Installed = !String.IsNullOrWhiteSpace(desktop);
                provider.ResolvedCommand = desktop;
                string cli = ResolveCommand("paseo");
                if (!String.IsNullOrWhiteSpace(cli))
                {
                    CommandResult r = RunCapture(cli, "--version", 6000);
                    provider.Version = CleanVersion(r.Output);
                }
                provider.Authenticated = true;
                provider.AuthKnown = true;
                provider.Selected = true;
                return;
            }

            string command = ResolveCommand(provider.Command);
            if (String.IsNullOrWhiteSpace(command) && !String.IsNullOrWhiteSpace(provider.AlternateCommand)) command = ResolveCommand(provider.AlternateCommand);
            if (String.IsNullOrWhiteSpace(command)) return;
            provider.ResolvedCommand = command;
            CommandResult version = RunCapture(command, provider.VersionArguments, 8000);
            provider.Installed = version.Started && !String.IsNullOrWhiteSpace(version.Output);
            provider.Version = CleanVersion(version.Output);
            if (!provider.Installed) return;

            if (provider.Id == "local")
            {
                provider.AuthKnown = true;
                provider.Authenticated = false;
                if (!String.IsNullOrWhiteSpace(localModel))
                {
                    try
                    {
                        List<string> models = DiscoverLocalModels(localEndpoint);
                        provider.Authenticated = models.Any(delegate(string value) { return String.Equals(value, localModel, StringComparison.OrdinalIgnoreCase); });
                        provider.VerificationDetail = provider.Authenticated ? "" : "The configured model was not returned by the local server.";
                    }
                    catch (Exception error)
                    {
                        provider.VerificationDetail = error.Message;
                    }
                }
                provider.Version = provider.Authenticated ? localModel + " · local" : "OpenCode ready";
                if (preserveSelection) provider.Selected = provider.Selected && provider.Authenticated;
                else if (hasExistingGuardConfig) provider.Selected = provider.Authenticated && preferredProviderOrder.Contains(provider.Id);
                else provider.Selected = false;
                return;
            }

            if (provider.Id == "node")
            {
                Match major = Regex.Match(provider.Version ?? "", @"(\d+)");
                provider.Installed = major.Success && Int32.Parse(major.Groups[1].Value) >= 22;
                provider.Authenticated = true;
                provider.AuthKnown = true;
                provider.Selected = true;
                if (!provider.Installed) provider.Version = "Needs v22+";
                return;
            }

            if (provider.AuthKind == AuthKind.Claude)
            {
                CommandResult auth = RunCapture(command, "auth status", 8000);
                provider.AuthKnown = true;
                provider.Authenticated = auth.Output.IndexOf("\"loggedIn\": true", StringComparison.OrdinalIgnoreCase) >= 0 || auth.Output.IndexOf("logged in", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            else if (provider.AuthKind == AuthKind.Codex)
            {
                CommandResult auth = RunCapture(command, "login status", 8000);
                provider.AuthKnown = true;
                provider.Authenticated = auth.Output.IndexOf("logged in", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            else if (provider.AuthKind == AuthKind.Cursor)
            {
                CommandResult auth = RunCapture(command, "status", 8000);
                provider.AuthKnown = true;
                provider.Authenticated = auth.Output.IndexOf("logged in", StringComparison.OrdinalIgnoreCase) >= 0 || auth.Output.IndexOf("authenticated", StringComparison.OrdinalIgnoreCase) >= 0;
                provider.SignInCommand = Path.GetFileNameWithoutExtension(command) + " login";
            }
            else if (provider.VerificationSupported)
            {
                provider.AuthKnown = true;
                provider.Authenticated = keepLiveVerification || HasStoredSignIn(provider.Id);
                provider.LiveVerified = keepLiveVerification;
            }
            else
            {
                provider.AuthKnown = false;
                provider.Authenticated = false;
            }

            if (!provider.Required)
            {
                if (preserveSelection) provider.Selected = provider.Selected && provider.CanUse;
                else if (hasExistingGuardConfig) provider.Selected = provider.CanUse && preferredProviderOrder.Contains(provider.Id);
                else provider.Selected = provider.CanUse;
            }
        }

        private void ConfigureLocalModel(ProviderInfo provider)
        {
            Window dialog = new Window
            {
                Title = "Configure a local model",
                Width = 650,
                Height = 565,
                Owner = this,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                WindowStyle = WindowStyle.None,
                AllowsTransparency = true,
                Background = Brushes.Transparent,
                ResizeMode = ResizeMode.NoResize,
                FontFamily = new FontFamily("Segoe UI")
            };

            Border shell = new Border
            {
                Margin = new Thickness(14),
                CornerRadius = new CornerRadius(24),
                Background = B("#FBFCFE"),
                BorderBrush = B("#D9DEE8"),
                BorderThickness = new Thickness(1),
                Effect = new DropShadowEffect { BlurRadius = 30, ShadowDepth = 8, Opacity = 0.25, Color = Color.FromRgb(35, 43, 58) },
                Padding = new Thickness(30, 24, 30, 26)
            };
            StackPanel panel = new StackPanel();
            shell.Child = panel;
            dialog.Content = shell;

            Grid heading = new Grid { Margin = new Thickness(0, 0, 0, 17) };
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            StackPanel title = new StackPanel();
            title.Children.Add(new TextBlock { Text = "LOCAL FALLBACK", FontSize = 9.5, FontWeight = FontWeights.Bold, Foreground = B("#755DDD") });
            title.Children.Add(new TextBlock { Text = "Add a private coding model.", FontSize = 23, FontWeight = FontWeights.SemiBold, Foreground = B("#171A21"), Margin = new Thickness(0, 5, 0, 0) });
            heading.Children.Add(title);
            Button close = ChromeButton("×");
            close.Click += delegate { dialog.Close(); };
            Grid.SetColumn(close, 1);
            heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            heading.Children.Add(close);
            heading.MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) { if (e.ButtonState == MouseButtonState.Pressed) dialog.DragMove(); };
            panel.Children.Add(heading);

            panel.Children.Add(new TextBlock
            {
                Text = "OpenCode gives the model real read, edit, and shell tools inside the shared Paseo workspace. The endpoint must be on this PC; Fleet Guard never stores an API key for it.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                LineHeight = 18,
                Foreground = B("#66707D"),
                Margin = new Thickness(0, 0, 0, 16)
            });

            Border requirements = new Border { CornerRadius = new CornerRadius(13), Background = B("#F0F3FA"), Padding = new Thickness(14), Margin = new Thickness(0, 0, 0, 16) };
            Grid requirementGrid = new Grid();
            requirementGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            requirementGrid.Children.Add(new TextBlock { Text = "You need OpenCode plus a running local server such as Ollama, LM Studio, or llama.cpp.", TextWrapping = TextWrapping.Wrap, FontSize = 10.5, Foreground = B("#606A7A"), VerticalAlignment = VerticalAlignment.Center });
            StackPanel requirementButtons = new StackPanel { Orientation = Orientation.Horizontal };
            Button getOpenCode = SmallDialogButton("Get OpenCode");
            getOpenCode.Margin = new Thickness(0, 0, 7, 0);
            getOpenCode.Click += delegate { OpenUrl("https://opencode.ai/docs/"); };
            Button getOllama = SmallDialogButton("Get Ollama");
            getOllama.Click += delegate { OpenUrl("https://ollama.com/download/windows"); };
            requirementButtons.Children.Add(getOpenCode);
            requirementButtons.Children.Add(getOllama);
            Grid.SetColumn(requirementButtons, 1);
            requirementGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            requirementGrid.Children.Add(requirementButtons);
            requirements.Child = requirementGrid;
            panel.Children.Add(requirements);

            panel.Children.Add(new TextBlock { Text = "Local API endpoint", FontSize = 10.5, FontWeight = FontWeights.SemiBold, Foreground = B("#4C5461"), Margin = new Thickness(0, 0, 0, 5) });
            TextBox endpointBox = new TextBox
            {
                Text = localEndpoint,
                FontSize = 12,
                Padding = new Thickness(10, 8, 10, 8),
                Background = Brushes.White,
                BorderBrush = B("#D9DEE7"),
                BorderThickness = new Thickness(1),
                ToolTip = "Use an OpenAI-compatible endpoint on localhost. Ollama defaults to http://127.0.0.1:11434/v1"
            };
            panel.Children.Add(endpointBox);

            panel.Children.Add(new TextBlock { Text = "Model", FontSize = 10.5, FontWeight = FontWeights.SemiBold, Foreground = B("#4C5461"), Margin = new Thickness(0, 14, 0, 5) });
            Grid modelGrid = new Grid();
            modelGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            modelGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            ComboBox modelBox = new ComboBox
            {
                IsEditable = true,
                Text = localModel,
                FontSize = 12,
                Padding = new Thickness(8, 6, 8, 6),
                Background = Brushes.White,
                BorderBrush = B("#D9DEE7"),
                MinHeight = 36
            };
            modelGrid.Children.Add(modelBox);
            Button discover = SecondaryButton("Find models");
            discover.Margin = new Thickness(9, 0, 0, 0);
            Grid.SetColumn(discover, 1);
            modelGrid.Children.Add(discover);
            panel.Children.Add(modelGrid);

            TextBlock feedback = new TextBlock { Text = "Start the local server, then find its available models.", FontSize = 10.5, Foreground = B("#7A818D"), Margin = new Thickness(1, 8, 0, 0), TextWrapping = TextWrapping.Wrap };
            panel.Children.Add(feedback);

            discover.Click += async delegate
            {
                discover.IsEnabled = false;
                endpointBox.IsEnabled = false;
                feedback.Text = "Checking the local server...";
                feedback.Foreground = B("#596CC7");
                try
                {
                    List<string> models = await Task.Run(delegate { return DiscoverLocalModels(endpointBox.Text); });
                    modelBox.Items.Clear();
                    foreach (string model in models) modelBox.Items.Add(model);
                    if (String.IsNullOrWhiteSpace(modelBox.Text) || !models.Any(delegate(string value) { return String.Equals(value, modelBox.Text, StringComparison.OrdinalIgnoreCase); })) modelBox.SelectedIndex = 0;
                    feedback.Text = models.Count == 1 ? "Found 1 local model." : "Found " + models.Count + " local models. Choose the one that should receive fallback work.";
                    feedback.Foreground = B("#26724E");
                }
                catch (Exception error)
                {
                    feedback.Text = error.Message;
                    feedback.Foreground = B("#A54E35");
                }
                finally
                {
                    discover.IsEnabled = true;
                    endpointBox.IsEnabled = true;
                }
            };

            Grid actions = new Grid { Margin = new Thickness(0, 22, 0, 0) };
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            TextBlock privacy = new TextBlock { Text = "Same-PC endpoints only", FontSize = 10, Foreground = B("#8A909B"), VerticalAlignment = VerticalAlignment.Center };
            actions.Children.Add(privacy);
            Button save = PrimaryButton("Use this model");
            Grid.SetColumn(save, 1);
            actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            actions.Children.Add(save);
            panel.Children.Add(actions);

            save.Click += delegate
            {
                try
                {
                    string endpoint = NormalizeLocalEndpoint(endpointBox.Text);
                    string model = String.Concat(modelBox.Text ?? "").Trim();
                    if (String.IsNullOrWhiteSpace(model)) throw new InvalidOperationException("Choose a model returned by the local server.");
                    List<string> models = DiscoverLocalModels(endpoint);
                    if (!models.Any(delegate(string value) { return String.Equals(value, model, StringComparison.OrdinalIgnoreCase); })) throw new InvalidOperationException("That model was not returned by the local server. Click Find models and choose one from the list.");
                    string openCode = ResolveCommand("opencode");
                    if (String.IsNullOrWhiteSpace(openCode)) throw new InvalidOperationException("OpenCode is not installed yet. Use Get OpenCode, finish its installation, and then try again.");

                    localEndpoint = endpoint;
                    localModel = models.First(delegate(string value) { return String.Equals(value, model, StringComparison.OrdinalIgnoreCase); });
                    provider.ResolvedCommand = openCode;
                    provider.Installed = true;
                    provider.AuthKnown = true;
                    provider.Authenticated = true;
                    provider.VerificationDetail = "";
                    provider.Version = localModel + " · local";
                    provider.Selected = true;
                    dialog.DialogResult = true;
                }
                catch (Exception error)
                {
                    feedback.Text = error.Message;
                    feedback.Foreground = B("#A54E35");
                }
            };

            if (dialog.ShowDialog() == true && provider.Row != null) provider.Row.Refresh();
        }

        private static Button SmallDialogButton(string text)
        {
            return new Button
            {
                Content = text,
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Foreground = B("#444C59"),
                Background = Brushes.White,
                BorderBrush = B("#D9DEE7"),
                BorderThickness = new Thickness(1),
                Padding = new Thickness(10, 6, 10, 6),
                Cursor = Cursors.Hand
            };
        }

        private static string NormalizeLocalEndpoint(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(String.Concat(value ?? "").Trim(), UriKind.Absolute, out uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                throw new InvalidOperationException("Enter a valid local HTTP endpoint, such as http://127.0.0.1:11434/v1.");
            if (!uri.IsLoopback) throw new InvalidOperationException("For privacy, Fleet Guard local models must use localhost or 127.0.0.1 on this PC.");
            string path = uri.AbsolutePath.TrimEnd('/');
            if (String.IsNullOrWhiteSpace(path)) path = "/v1";
            return uri.GetLeftPart(UriPartial.Authority) + path;
        }

        private static List<string> DiscoverLocalModels(string endpoint)
        {
            string normalized = NormalizeLocalEndpoint(endpoint);
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(normalized + "/models");
            request.Method = "GET";
            request.Accept = "application/json";
            request.Timeout = 6000;
            request.ReadWriteTimeout = 6000;
            request.Proxy = null;
            string json;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream())) json = reader.ReadToEnd();

            Dictionary<string, object> root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            object raw;
            object[] data;
            if (root == null || !root.TryGetValue("data", out raw) || (data = raw as object[]) == null)
                throw new InvalidOperationException("The local server answered, but its /v1/models response was not OpenAI-compatible.");
            List<string> models = new List<string>();
            foreach (object entry in data)
            {
                Dictionary<string, object> item = entry as Dictionary<string, object>;
                object id;
                if (item != null && item.TryGetValue("id", out id) && id != null && !String.IsNullOrWhiteSpace(id.ToString())) models.Add(id.ToString());
            }
            models = models.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(delegate(string value) { return value; }, StringComparer.OrdinalIgnoreCase).ToList();
            if (models.Count == 0) throw new InvalidOperationException("The local server is running, but it did not report any models. Pull or load a model first, then try again.");
            return models;
        }

        private void LaunchSignIn(ProviderInfo provider)
        {
            if (String.IsNullOrWhiteSpace(provider.SignInCommand)) return;
            try
            {
                provider.LiveVerified = false;
                provider.VerificationFailed = false;
                if (provider.Row != null) provider.Row.ShowWorking("Signing in...");
                Process process = Process.Start(new ProcessStartInfo("cmd.exe", "/d /c " + provider.SignInCommand) { UseShellExecute = true, WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) });
                if (process == null) throw new InvalidOperationException("The sign-in window did not start.");
                Task.Run(delegate
                {
                    process.WaitForExit();
                    process.Dispose();
                }).ContinueWith(delegate
                {
                    InspectProvider(provider, true);
                    Dispatcher.Invoke(delegate
                    {
                        if (provider.Row != null) provider.Row.Refresh();
                        if (provider.VerificationSupported && provider.Authenticated)
                        {
                            MessageBox.Show(this, "Sign-in was found. Verify is optional: it sends one short no-tools request and uses provider quota. Antigravity may count a large fixed input context even for this short test.", provider.Name, MessageBoxButton.OK, MessageBoxImage.Information);
                        }
                    });
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not open the sign-in window.\n\n" + ex.Message, "Sign-in", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void VerifyProvider(ProviderInfo provider)
        {
            if (!provider.Installed || !provider.VerificationSupported || provider.VerificationRunning) return;
            provider.VerificationRunning = true;
            provider.VerificationFailed = false;
            if (provider.Row != null) provider.Row.Refresh();

            Task.Run(delegate
            {
                string arguments;
                int timeout;
                if (provider.Id == "antigravity")
                {
                    arguments = "-p \"Reply with exactly FLEET_GUARD_AUTH_OK. Do not use tools.\" --output-format json --print-timeout 45s --dangerously-skip-permissions";
                    timeout = 70000;
                }
                else
                {
                    arguments = "-sp \"Reply with exactly FLEET_GUARD_AUTH_OK. Do not inspect or modify files.\" --allow-all-tools --no-custom-instructions --disable-builtin-mcps --no-remote --no-remote-export";
                    timeout = 70000;
                }

                CommandResult verification = RunCapture(provider.ResolvedCommand, arguments, timeout, Path.GetTempPath());
                bool passed = verification.ExitCode == 0 && verification.Output.IndexOf("FLEET_GUARD_AUTH_OK", StringComparison.OrdinalIgnoreCase) >= 0;
                provider.VerificationRunning = false;
                provider.LiveVerified = passed;
                provider.VerificationFailed = !passed;
                provider.VerificationDetail = passed ? "" : Tail(verification.Output, 500);
                provider.AuthKnown = true;
                if (passed)
                {
                    provider.Authenticated = true;
                    provider.Selected = true;
                }
                else
                {
                    provider.Authenticated = provider.Authenticated || HasStoredSignIn(provider.Id);
                }
            }).ContinueWith(delegate(Task verificationTask)
            {
                if (verificationTask.IsFaulted)
                {
                    provider.VerificationRunning = false;
                    provider.LiveVerified = false;
                    provider.VerificationFailed = true;
                    provider.VerificationDetail = verificationTask.Exception.GetBaseException().Message;
                }
                Dispatcher.Invoke(delegate
                {
                    if (provider.Row != null) provider.Row.Refresh();
                });
            });
        }

        private static bool HasStoredSignIn(string providerId)
        {
            CommandResult credentials = RunCapture("cmdkey.exe", "/list", 5000);
            if (!credentials.Started) return false;
            if (providerId == "antigravity")
            {
                return credentials.Output.IndexOf("gemini:antigravity", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            if (providerId == "copilot")
            {
                if (credentials.Output.IndexOf("copilot-cli", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                return !String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("COPILOT_GITHUB_TOKEN"))
                    || !String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GH_TOKEN"))
                    || !String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GITHUB_TOKEN"));
            }
            return false;
        }

        private void InstallGuard()
        {
            if (installing) return;
            List<ProviderInfo> ordered = chainList.Items.Cast<ProviderInfo>().ToList();
            if (ordered.Count == 0) return;
            string generatedConfig = BuildConfig(ordered);
            installing = true;
            backButton.Visibility = Visibility.Collapsed;
            nextButton.IsEnabled = false;
            body.Children.Clear();
            eyebrow.Text = "INSTALLING";
            pageTitle.Text = "Building your Fleet.";
            pageSubtitle.Text = "This usually takes less than a minute. The window can stay in the background.";
            installProgress.IsIndeterminate = true;
            installProgress.Height = 5;
            installProgress.Foreground = B("#6878DF");
            installProgress.Background = B("#E4E7EF");
            installProgress.Margin = new Thickness(0, 30, 0, 18);
            body.Children.Add(installProgress);
            installStatus.Text = "Preparing the local installation...";
            installStatus.FontSize = 12;
            installStatus.Foreground = B("#626A76");
            body.Children.Add(installStatus);

            Task.Run(delegate { PerformInstall(ordered, generatedConfig); }).ContinueWith(delegate(Task task)
            {
                Dispatcher.Invoke(delegate
                {
                    installing = false;
                    if (task.IsFaulted)
                    {
                        Exception error = task.Exception.GetBaseException();
                        installProgress.IsIndeterminate = false;
                        installProgress.Value = 0;
                        installStatus.Text = "Setup stopped: " + error.Message;
                        installStatus.Foreground = B("#A64C36");
                        backButton.Visibility = Visibility.Visible;
                        nextButton.Content = "Try again";
                        nextButton.IsEnabled = true;
                        return;
                    }
                    ShowStep(3);
                });
            });
        }

        private void PerformInstall(List<ProviderInfo> ordered, string generatedConfig)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string temporaryPayload;
            string payload = ResolvePayload(baseDir, out temporaryPayload);
            try
            {
                string installDir = Environment.GetEnvironmentVariable("FLEET_GUARD_INSTALL_DIR");
                if (String.IsNullOrWhiteSpace(installDir)) installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PaseoFleetGuard");
                Directory.CreateDirectory(installDir);
                UpdateInstallStatus("Copying Fleet Guard...");
                if (!String.Equals(Path.GetFullPath(payload).TrimEnd(Path.DirectorySeparatorChar), Path.GetFullPath(installDir).TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    CopyDirectory(payload, installDir);
                string currentSetup = Assembly.GetExecutingAssembly().Location;
                string installedSetup = Path.Combine(installDir, "FleetGuardSetup.exe");
                if (!String.Equals(Path.GetFullPath(currentSetup), Path.GetFullPath(installedSetup), StringComparison.OrdinalIgnoreCase))
                {
                    File.Copy(currentSetup, installedSetup, true);
                }

                string guardHome = GuardStateHome();
                Directory.CreateDirectory(guardHome);
                string configPath = Path.Combine(guardHome, "config.json");
                if (File.Exists(configPath))
                {
                    string backup = Path.Combine(guardHome, "config.before-friendly-setup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
                    File.Copy(configPath, backup, true);
                }
                File.WriteAllText(configPath, generatedConfig, new UTF8Encoding(false));

                UpdateInstallStatus("Installing the small local Paseo connector...");
                string npm = ResolveCommand("npm.cmd");
                if (String.IsNullOrWhiteSpace(npm)) npm = ResolveCommand("npm");
                if (String.IsNullOrWhiteSpace(npm)) throw new InvalidOperationException("npm was not found after Node.js detection. Restart Windows after installing Node.js, then try again.");
                CommandResult npmResult = RunCapture(npm, "ci --omit=dev --no-audit --no-fund", 180000, installDir);
                if (npmResult.ExitCode != 0) throw new InvalidOperationException("The local connector could not be installed. " + Tail(npmResult.Output, 350));

                UpdateInstallStatus("Creating your combined Paseo shortcut...");
                string node = ResolveCommand("node");
                CommandResult install = RunCapture(node, "install.mjs", 60000, installDir);
                if (install.ExitCode != 0) throw new InvalidOperationException("The Paseo shortcut could not be created. " + Tail(install.Output, 500));
                installedGuidePath = Path.Combine(installDir, "Usage Guide.html");
            }
            finally
            {
                if (!String.IsNullOrWhiteSpace(temporaryPayload))
                {
                    try { Directory.Delete(temporaryPayload, true); } catch { }
                }
            }
        }

        private string BuildConfig(List<ProviderInfo> ordered)
        {
            List<object> fallbacks = new List<object>();
            foreach (ProviderInfo provider in ordered)
            {
                if (provider.Id == "codex")
                    fallbacks.Add(new Dictionary<string, object> { { "id", "codex" }, { "kind", "paseo" }, { "provider", "codex" }, { "modeId", "auto-review" } });
                else if (provider.Id == "antigravity")
                    fallbacks.Add(new Dictionary<string, object> { { "id", "antigravity" }, { "kind", "antigravity" } });
                else if (provider.Id == "cursor")
                    fallbacks.Add(new Dictionary<string, object> { { "id", "cursor" }, { "kind", "paseo" }, { "provider", "fleet-cursor" }, { "modeId", "agent" } });
                else if (provider.Id == "copilot")
                    fallbacks.Add(new Dictionary<string, object> { { "id", "copilot" }, { "kind", "paseo" }, { "provider", "copilot" }, { "modeId", "allow-all" } });
                else if (provider.Id == "local")
                    fallbacks.Add(new Dictionary<string, object> { { "id", "local" }, { "kind", "paseo" }, { "provider", "fleet-local/fleet-local-api/" + localModel } });
            }
            PolicyOption continuationMode = continuationModeBox.SelectedItem as PolicyOption ?? new PolicyOption { Value="single-pass" };
            PolicyOption nudgeCount = nudgeCountBox.SelectedItem as PolicyOption ?? new PolicyOption { Number=0 };
            PolicyOption retryDelay = retryDelayBox.SelectedItem as PolicyOption ?? new PolicyOption { Number=15 };
            Dictionary<string, object> continuation = new Dictionary<string, object>
            {
                { "mode", continuationMode.Value },
                { "sameAgentNudges", nudgeCount.Number },
                { "verifyCompletion", verifyCompletionBox.IsChecked == true },
                { "reuseSessions", reuseSessionsBox.IsChecked == true },
                { "retryDelayMinutes", retryDelay.Number },
                { "maxCycles", 0 }
            };
            Dictionary<string, object> config = new Dictionary<string, object>
            {
                { "enabled", true },
                { "daemonUrl", "ws://127.0.0.1:6767/ws" },
                { "watchProviderPrefixes", new [] { "claude/", "claude" } },
                { "onlyRootClaudeAgents", true },
                { "recentTimelineEntries", 100 },
                { "recentContextCharacters", 28000 },
                { "catchUpWindowMinutes", 240 },
                { "continuationPolicy", continuation },
                { "localModel", new Dictionary<string, object> { { "endpoint", localEndpoint }, { "model", localModel } } },
                { "fallbackOrder", fallbacks }
            };
            JavaScriptSerializer json = new JavaScriptSerializer();
            return PrettyJson(json.Serialize(config)) + Environment.NewLine;
        }

        private static string PrettyJson(string json)
        {
            StringBuilder result = new StringBuilder();
            bool quoted = false;
            bool escaped = false;
            int indent = 0;
            foreach (char ch in json)
            {
                if (escaped) { result.Append(ch); escaped = false; continue; }
                if (ch == '\\' && quoted) { result.Append(ch); escaped = true; continue; }
                if (ch == '"') { quoted = !quoted; result.Append(ch); continue; }
                if (quoted) { result.Append(ch); continue; }
                if (ch == '{' || ch == '[') { result.Append(ch); result.AppendLine(); indent++; result.Append(new string(' ', indent * 2)); }
                else if (ch == '}' || ch == ']') { result.AppendLine(); indent--; result.Append(new string(' ', indent * 2)); result.Append(ch); }
                else if (ch == ',') { result.Append(ch); result.AppendLine(); result.Append(new string(' ', indent * 2)); }
                else if (ch == ':') result.Append(": ");
                else result.Append(ch);
            }
            return result.ToString();
        }

        private void UpdateInstallStatus(string value)
        {
            Dispatcher.Invoke(delegate { installStatus.Text = value; });
        }

        private static string ResolvePayload(string baseDir, out string temporaryPayload)
        {
            temporaryPayload = null;
            string adjacent = Path.Combine(baseDir, "payload");
            if (Directory.Exists(adjacent) && File.Exists(Path.Combine(adjacent, "install.mjs"))) return adjacent;
            if (File.Exists(Path.Combine(baseDir, "install.mjs")) && Directory.Exists(Path.Combine(baseDir, "src"))) return baseDir;

            Stream embedded = Assembly.GetExecutingAssembly().GetManifestResourceStream("FleetGuardPayload.zip");
            if (embedded == null) throw new InvalidOperationException("The embedded Fleet Guard payload is missing. Download the installer again.");
            temporaryPayload = Path.Combine(Path.GetTempPath(), "FleetGuardSetup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temporaryPayload);
            string safeRoot = Path.GetFullPath(temporaryPayload).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            using (embedded)
            using (ZipArchive archive = new ZipArchive(embedded, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(temporaryPayload, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(safeRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The embedded payload contains an invalid path.");
                    if (String.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                }
            }
            if (!File.Exists(Path.Combine(temporaryPayload, "install.mjs"))) throw new InvalidOperationException("The embedded Fleet Guard payload could not be unpacked.");
            return temporaryPayload;
        }

        private static void CopyDirectory(string source, string destination)
        {
            foreach (string directory in Directory.GetDirectories(source, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(directory.Replace(source, destination));
            }
            foreach (string file in Directory.GetFiles(source, "*", SearchOption.AllDirectories))
            {
                string target = file.Replace(source, destination);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(file, target, true);
            }
        }

        private static void RefreshPath()
        {
            string machine = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
            string user = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
            Environment.SetEnvironmentVariable("Path", machine + ";" + user, EnvironmentVariableTarget.Process);
        }

        private static string ResolveCommand(string command)
        {
            if (String.IsNullOrWhiteSpace(command)) return "";
            if (Path.IsPathRooted(command) && File.Exists(command)) return command;
            CommandResult where = RunCapture("where.exe", command, 4000);
            if (!where.Started) return "";
            string[] found = where.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            string first = found.FirstOrDefault(delegate(string item)
            {
                string extension = Path.GetExtension(item).ToLowerInvariant();
                return extension == ".exe" || extension == ".cmd" || extension == ".bat" || extension == ".com";
            }) ?? found.FirstOrDefault();
            return first == null ? "" : first.Trim();
        }

        private static string FindPaseoDesktop()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string[] guesses =
            {
                Path.Combine(local, "Programs", "Paseo", "Paseo.exe"),
                Path.Combine(local, "Paseo", "Paseo.exe"),
                Path.Combine(programFiles, "Paseo", "Paseo.exe")
            };
            foreach (string guess in guesses) if (File.Exists(guess)) return guess;
            string script = "$ErrorActionPreference='SilentlyContinue'; $w=New-Object -ComObject WScript.Shell; $r=@([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory')) | ? {$_ -and (Test-Path $_)}; foreach($x in $r){Get-ChildItem -LiteralPath $x -Filter '*.lnk' -Recurse | ? {$_.BaseName -match 'Paseo' -and $_.BaseName -notmatch 'Fleet Guard|Fleet Supervisor'} | % {$t=$w.CreateShortcut($_.FullName).TargetPath; if($t -and (Test-Path $t)){Write-Output $t; break}}}";
            CommandResult found = RunCapture("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \"" + script.Replace("\"", "\\\"") + "\"", 10000);
            return found.Output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        }

        private sealed class CommandResult
        {
            public bool Started;
            public int ExitCode = -1;
            public string Output = "";
        }

        private static CommandResult RunCapture(string file, string arguments, int timeout)
        {
            return RunCapture(file, arguments, timeout, null);
        }

        private static CommandResult RunCapture(string file, string arguments, int timeout, string workingDirectory)
        {
            CommandResult result = new CommandResult();
            try
            {
                string executable = file;
                string effectiveArguments = arguments ?? "";
                string extension = Path.GetExtension(file).ToLowerInvariant();
                if (extension == ".cmd" || extension == ".bat")
                {
                    executable = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe";
                    effectiveArguments = "/d /s /c \"\"" + file + "\" " + effectiveArguments + "\"";
                }
                else if (extension == ".ps1")
                {
                    executable = "powershell.exe";
                    effectiveArguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + file + "\" " + effectiveArguments;
                }
                ProcessStartInfo info = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = effectiveArguments,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WorkingDirectory = String.IsNullOrWhiteSpace(workingDirectory) ? Environment.CurrentDirectory : workingDirectory
                };
                using (Process process = new Process())
                {
                    process.StartInfo = info;
                    result.Started = process.Start();
                    Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderrTask = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(timeout))
                    {
                        try { process.Kill(); } catch { }
                        try { process.WaitForExit(2000); } catch { }
                        result.Output = (stdoutTask.IsCompleted ? stdoutTask.Result : "") + Environment.NewLine + (stderrTask.IsCompleted ? stderrTask.Result : "") + Environment.NewLine + "Timed out.";
                        return result;
                    }
                    string stdout = stdoutTask.Result;
                    string stderr = stderrTask.Result;
                    result.ExitCode = process.ExitCode;
                    result.Output = (stdout + Environment.NewLine + stderr).Trim();
                }
            }
            catch (Exception ex)
            {
                result.Output = ex.Message;
            }
            return result;
        }

        private static string CleanVersion(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";
            string line = value.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
            line = Regex.Replace(line.Trim(), @"\s+", " ");
            if (line.Length > 22) line = line.Substring(0, 22) + "...";
            return line;
        }

        private static string GuardStateHome()
        {
            string configured = Environment.GetEnvironmentVariable("FLEET_GUARD_STATE_HOME");
            if (!String.IsNullOrWhiteSpace(configured)) return configured;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".paseo-fleet-guard");
        }

        private static string Tail(string text, int max)
        {
            if (String.IsNullOrWhiteSpace(text)) return "No diagnostic text was returned.";
            text = Regex.Replace(text.Trim(), @"\s+", " ");
            return text.Length <= max ? text : text.Substring(text.Length - max);
        }

        private static void OpenUrl(string url)
        {
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
            catch { }
        }

        private static Border GlassCard()
        {
            return new Border { CornerRadius = new CornerRadius(22), Background = B("#FFFFFFDC"), BorderBrush = B("#E1E5EC"), BorderThickness = new Thickness(1), Padding = new Thickness(22) };
        }

        private static StackPanel Feature(string text)
        {
            StackPanel row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 12) };
            Border tick = new Border { Width = 21, Height = 21, CornerRadius = new CornerRadius(7), Background = B("#EBF0FF"), Child = new TextBlock { Text = "\u2713", FontSize = 11, FontWeight = FontWeights.Bold, Foreground = B("#6374D8"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center } };
            row.Children.Add(tick);
            row.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = B("#535A66"), Margin = new Thickness(10, 1, 0, 0), MaxWidth = 420 });
            return row;
        }

        private static Border FlowNode(string title, string subtitle, string color)
        {
            Border node = new Border { CornerRadius = new CornerRadius(13), Background = B("#FFFFFFDD"), BorderBrush = B("#E1E4EC"), BorderThickness = new Thickness(1), Padding = new Thickness(12, 9, 12, 9) };
            StackPanel panel = new StackPanel();
            panel.Children.Add(new TextBlock { Text = title, FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = B(color), HorizontalAlignment = HorizontalAlignment.Center });
            panel.Children.Add(new TextBlock { Text = subtitle, FontSize = 9.5, Foreground = B("#7D8490"), HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 2, 0, 0) });
            node.Child = panel;
            return node;
        }

        private static Button PrimaryButton(string text)
        {
            return new Button { Content = text, MinWidth = 132, Height = 38, Padding = new Thickness(18, 0, 18, 0), FontSize = 12, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, Background = B("#6273DA"), BorderBrush = B("#6273DA"), BorderThickness = new Thickness(1), Cursor = Cursors.Hand };
        }

        private static Button SecondaryButton(string text)
        {
            return new Button { Content = text, MinWidth = 82, Height = 34, Padding = new Thickness(14, 0, 14, 0), FontSize = 11.5, FontWeight = FontWeights.SemiBold, Foreground = B("#48505C"), Background = B("#FFFFFF"), BorderBrush = B("#DDE1E8"), BorderThickness = new Thickness(1), Cursor = Cursors.Hand };
        }

        private static ComboBox ChoiceBox(IEnumerable<PolicyOption> options, int selectedIndex)
        {
            ComboBox box = new ComboBox
            {
                ItemsSource = options.ToList(),
                DisplayMemberPath = "Name",
                SelectedIndex = selectedIndex,
                Height = 31,
                MinWidth = 155,
                Padding = new Thickness(8, 2, 8, 2),
                FontSize = 10.5,
                Foreground = B("#343B47"),
                Background = Brushes.White,
                BorderBrush = B("#DCE1EA")
            };
            return box;
        }

        private static Button ChromeButton(string text)
        {
            return new Button { Content = text, Width = 38, Height = 32, FontSize = 16, Foreground = B("#636A75"), Background = Brushes.Transparent, BorderThickness = new Thickness(0), Cursor = Cursors.Hand };
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            Application app = new Application();
            app.ShutdownMode = ShutdownMode.OnMainWindowClose;
            app.Run(new MainWindow());
        }
    }
}
