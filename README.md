# Pracownia — prosta instrukcja

## 1. Co to jest?

To strona do wymiany plików między osobami robiącymi grę. Wygląda dobrze na komputerze i telefonie — to ta sama strona, a nie osobna aplikacja do instalacji.

Pliki są przechowywane w folderze Google Drive. Strona pozwala je przeglądać, wysyłać i pobierać, tworzyć foldery oraz przenosić rzeczy do kosza. Każdy loguje się na swoje konto Google.

**Ważne:** strona wymaga dostępu do **całego Dysku Google** osoby, która się loguje, choć pokazuje tylko folder projektu. Dla bezpieczeństwa użyjcie osobnych kont Google przeznaczonych do gry. Nie podawajcie stronie haseł — logowanie odbywa się w oknie Google.

## 2. Jak uruchomić stronę na swoim komputerze?

1. Zainstaluj [Node.js](https://nodejs.org/), jeśli jeszcze go nie masz. Wybierz wersję LTS.
2. Otwórz folder, w którym znajduje się ta instrukcja.
3. Kliknij dwa razy plik `URUCHOM.bat`. Zostaw otwarte czarne okno, które się pojawi.
4. W przeglądarce wpisz **http://localhost:8000**.
5. Aby wyłączyć stronę, zamknij czarne okno.

Możesz od razu obejrzeć wygląd strony. **Logowanie i pliki zaczną działać dopiero po konfiguracji opisanej niżej.**

Ten adres działa tylko na Twoim komputerze. Znajomi nie zobaczą strony pod swoim adresem `localhost`. Jak udostępnić stronę online, opisano w punkcie 8.

## 3. Utwórz folder na pliki

1. Wejdź na [Google Drive](https://drive.google.com/) i zaloguj się na konto przeznaczone do gry.
2. Kliknij **Nowy → Nowy folder**. Nazwij go np. `Pliki gry`.
3. Kliknij folder prawym przyciskiem, wybierz **Udostępnij**, wpisz adresy Google znajomych i nadaj im uprawnienie **Edytujący**. Dostęp ogólny pozostaw jako ograniczony.
4. Otwórz ten folder. Jego adres wygląda podobnie do:

   `https://drive.google.com/drive/folders/ABC123xyz`

5. Skopiuj część po `folders/` — w tym przykładzie jest to `ABC123xyz`. To **identyfikator folderu**. Potrzebujesz go w punkcie 7.

## 4. Utwórz projekt Google

1. Wejdź na [Google Cloud Console](https://console.cloud.google.com/) i zaloguj się.
2. Na górze strony kliknij wybór projektu, a następnie **Nowy projekt**.
3. Nazwij go np. `Pracownia gry`, kliknij **Utwórz** i wybierz nowo utworzony projekt.
4. Wejdź w menu **Interfejsy API i usługi → Biblioteka**.
5. Znajdź **Google Drive API**, otwórz je i kliknij **Włącz**.

Nazwy przycisków mogą się nieco różnić w zależności od języka i zmian w panelu Google.

## 5. Skonfiguruj logowanie

1. W menu Google Cloud wejdź w **Google Auth Platform**. Jeśli widzisz przycisk **Get started / Rozpocznij**, kliknij go.
2. Wpisz nazwę aplikacji, np. `Pracownia`, oraz swój adres e-mail do kontaktu.
3. Wybierz użytkowników **External / Zewnętrzni**, uzupełnij wymagane pola i zakończ konfigurację.
4. Otwórz **Audience / Odbiorcy**. Zostaw aplikację w trybie **Testing / Testowanie**.
5. W sekcji **Test users / Użytkownicy testowi** dodaj swój adres Google oraz adresy wszystkich znajomych. Muszą to być te same konta, którym udostępniono folder.
6. Otwórz **Data Access / Dostęp do danych** i dodaj zakres `https://www.googleapis.com/auth/drive`.

Google może pokazać ostrzeżenie o niezweryfikowanej aplikacji. Kontynuuj tylko wtedy, gdy rozpoznajesz swoją aplikację i rozumiesz, że przyznajesz jej dostęp do całego Dysku. Publikacja aplikacji poza trybem testowym może wymagać weryfikacji Google.

## 6. Utwórz identyfikator klienta

1. W **Google Auth Platform** otwórz **Clients / Klienci** i kliknij **Create client / Utwórz klienta**.
2. Wybierz typ **Web application / Aplikacja internetowa** i wpisz dowolną nazwę.
3. W części **Authorized JavaScript origins / Autoryzowane źródła JavaScript** dodaj dwa adresy:
   - `http://localhost`
   - `http://localhost:8000`
4. Kliknij **Utwórz**. Skopiuj **Client ID / Identyfikator klienta** — zwykle kończy się na `.apps.googleusercontent.com`.
5. **Nie kopiuj ani nie publikuj Client secret / Sekretu klienta.** Ta strona go nie potrzebuje.

## 7. Wpisz dane do strony

1. W folderze strony otwórz plik `config.js` w VS Code albo Notatniku.
2. Wstaw skopiowane dane między cudzysłowy:

   ```javascript
   window.APP_CONFIG = {
     clientId: "TUTAJ_WKLEJ_IDENTYFIKATOR_KLIENTA",
     folderId: "TUTAJ_WKLEJ_IDENTYFIKATOR_FOLDERU"
   };
   ```

3. Zapisz plik. Zachowaj cudzysłowy i przecinek.
4. Odśwież `http://localhost:8000`, kliknij **Zaloguj się przez Google** i wybierz konto mające dostęp do folderu.

Jeśli konfiguracja się udała, zobaczysz zawartość folderu. Przycisk **Dodaj pliki** wysyła pliki, **Nowy folder** tworzy folder, strzałka przy pliku go pobiera, a **×** przenosi element do kosza Google Drive.

## 8. Jak dać znajomym link do strony?

Jedna z darmowych możliwości to **GitHub Pages**. Potrzebujesz konta na [GitHubie](https://github.com/).

1. Na GitHubie utwórz nowe **publiczne** repozytorium, np. `pracownia`. W darmowym planie publikacja Pages z repozytorium wymaga publicznego repozytorium.
2. Przez **Add file → Upload files** wgraj do głównego folderu repozytorium tylko te cztery pliki: `index.html`, `style.css`, `app.js`, `config.js`. Zapisz zmiany przyciskiem **Commit changes**.
3. Otwórz **Settings → Pages**. W sekcji **Build and deployment** wybierz **Deploy from a branch**, gałąź `main` i folder `/ (root)`. Kliknij **Save**.
4. Poczekaj na publikację. W **Settings → Pages** pojawi się adres, np. `https://twoj-login.github.io/pracownia/`.
5. W Google Cloud wróć do klienta z punktu 6 i dodaj w **Authorized JavaScript origins** adres strony **bez ścieżki**, np. `https://twoj-login.github.io`. Zapisz zmianę.
6. Wyślij znajomym pełny adres strony. Każdy musi być użytkownikiem testowym Google i mieć dostęp do folderu Drive.

Kod strony i dane w `config.js` będą publiczne. Identyfikator klienta i identyfikator folderu nie są hasłami, ale nigdy nie umieszczaj tam sekretów ani haseł. Same pliki pozostają na Google Drive i są chronione jego uprawnieniami. Zabezpiecz konto GitHub, np. włączając uwierzytelnianie dwuskładnikowe.

Strona prosi wyszukiwarki o niewyświetlanie jej w wynikach wyszukiwania. Nie wszystkie wyszukiwarki muszą to respektować i nie jest to zabezpieczenie: każdy, kto zna adres, może otworzyć stronę. Dostęp do plików ograniczaj przez udostępnienie folderu wyłącznie konkretnym osobom.

## Jeśli coś nie działa

- **Strona się nie otwiera:** sprawdź, czy okno `URUCHOM.bat` jest otwarte i czy adres to `http://localhost:8000`. Jeśli port 8000 jest zajęty, zamknij aplikację, która go używa, albo skorzystaj z innego serwera i dodaj jego dokładny adres do Google OAuth.
- **Komunikat o konfiguracji:** sprawdź, czy oba pola w `config.js` są wypełnione i czy plik jest zapisany.
- **Błąd logowania:** sprawdź, czy Google Drive API jest włączone, konto znajduje się na liście użytkowników testowych, a dokładny adres strony jest dodany do autoryzowanych źródeł JavaScript.
- **Nie widać folderu:** sprawdź identyfikator folderu i upewnij się, że zalogowane konto zostało zaproszone do folderu.
- **Nie można dodać pliku:** sprawdź uprawnienie **Edytujący** oraz wolne miejsce na koncie Google osoby wysyłającej plik.

## Warto wiedzieć

- Konto Google ma do 15 GB miejsca współdzielonego z Gmailem i Zdjęciami. Pliki dodane do wspólnego folderu zwykle zajmują miejsce na koncie osoby, która je dodała. [Szczegóły Google](https://support.google.com/googleone/answer/9312312).
- Strona zapisuje token Google w pamięci przeglądarki, aby przywrócić sesję po odświeżeniu lub ponownym otwarciu strony. Po wygaśnięciu tokenu Google trzeba zalogować się ponownie. Nie korzystaj z tej funkcji na współdzielonym komputerze: osoba z dostępem do przeglądarki lub złośliwy skrypt na stronie może uzyskać dostęp do tokenu, który obejmuje cały Dysk. Wylogowanie usuwa zapisaną sesję i unieważnia upoważnienie aplikacji.
- Plików Google Docs i podobnych nie można pobrać z tej strony. Duże pliki są wysyłane częściami, lecz pobieranie wymaga pamięci przeglądarki na cały plik. Przerwane przesyłanie trzeba zacząć ponownie.
- Strona nie zastępuje kopii zapasowych ani systemu kontroli wersji całego projektu Unity. Jest przeznaczona do wymiany pojedynczych zasobów.
